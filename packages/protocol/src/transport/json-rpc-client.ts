import { Deferred, Effect, HashMap, Ref, Scope } from "effect";
import type { TSchema } from "@sinclair/typebox";
import {
  decodeRpcResult,
  type ParamsOf,
  type ResultOf,
  type RpcDefinition,
} from "./method.js";
import { JSON_RPC_RESERVED_CODES, errorClassFor } from "./wire-errors.js";
import { NotConnectedError, RpcServerError } from "./rpc-errors.js";
import type { JsonRpcId } from "./wire.js";
import { requestFrame, type ResponseFrame } from "./wire.js";
import type { RegisteredTaggedError } from "../rpc-registry.js";

type AnyRpcDefinition = RpcDefinition<string, TSchema, TSchema>;

type WriteError = unknown;

interface PendingCall {
  readonly method: string;
  readonly definition: AnyRpcDefinition;
  readonly deferred: Deferred.Deferred<unknown, RpcCallError>;
}

export type RpcCallError =
  | NotConnectedError
  | RpcServerError
  | RegisteredTaggedError;

/** Originator side of a JSON-RPC connection. Scope-bound: closing the
 * scope runs `failAllPending(NotConnectedError)`. Caller owns timeouts. */
export interface JsonRpcClient {
  readonly call: <D extends AnyRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, RpcCallError>;
  readonly resolve: (frame: ResponseFrame) => Effect.Effect<boolean>;
  readonly failAllPending: (error: NotConnectedError) => Effect.Effect<void>;
}

export const makeJsonRpcClient = (config: {
  readonly write: (raw: string) => Effect.Effect<void, WriteError>;
  readonly idPrefix: string;
}): Effect.Effect<JsonRpcClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const counterRef = yield* Ref.make(0);
    const pendingRef = yield* Ref.make(HashMap.empty<JsonRpcId, PendingCall>());

    const failAllPending = (error: NotConnectedError): Effect.Effect<void> =>
      Effect.gen(function* () {
        const drained = yield* Ref.getAndSet(
          pendingRef,
          HashMap.empty<JsonRpcId, PendingCall>(),
        );
        for (const [, entry] of HashMap.entries(drained)) {
          yield* Deferred.fail(entry.deferred, error).pipe(Effect.ignore);
        }
      });

    yield* Effect.addFinalizer(() =>
      failAllPending(
        new NotConnectedError({
          message: "JsonRpcClient scope closed with pending calls",
        }),
      ),
    );

    const resolve = (frame: ResponseFrame): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (frame.id === null) return false;
        const id = frame.id;
        const removed = yield* Ref.modify(pendingRef, (m) => {
          const entry = HashMap.get(m, id);
          return [entry, HashMap.remove(m, id)] as const;
        });
        if (removed._tag === "None") return false;
        const { deferred } = removed.value;
        if ("error" in frame && frame.error !== undefined) {
          const cls = errorClassFor(frame.error.code);
          const failureValue: RpcCallError =
            cls === undefined
              ? new RpcServerError({
                  code: frame.error.code,
                  message: frame.error.message,
                  data: frame.error.data,
                })
              : // The wire-error registry stores the class factory keyed
                // by code; the constructor produces a concrete tagged-error
                // instance whose runtime tag matches one of the union arms
                // in `RegisteredTaggedError`. The type system can't see
                // through the open-ended `new (...) => { _tag: string }`
                // factory shape, so the cast bridges the static factory
                // to the closed runtime union.
                (new cls() as RegisteredTaggedError);
          yield* Deferred.fail(deferred, failureValue).pipe(Effect.ignore);
          return true;
        }
        if ("result" in frame) {
          yield* Deferred.succeed(deferred, frame.result).pipe(Effect.ignore);
        }
        return true;
      });

    const call = <D extends AnyRpcDefinition>(
      definition: D,
      params: ParamsOf<D>,
    ): Effect.Effect<ResultOf<D>, RpcCallError> =>
      Effect.gen(function* () {
        const method = definition.name;
        const next = yield* Ref.modify(counterRef, (n) => {
          const value = n + 1;
          return [value, value] as const;
        });
        const frame = requestFrame(
          `${config.idPrefix}-${next}`,
          definition,
          params,
        );
        const id = frame.id;
        const deferred = yield* Deferred.make<unknown, RpcCallError>();

        // Issue #310 contract: the pending insert/remove are an
        // acquireUseRelease pair. Release runs on success, error, AND
        // interrupt, so a caller-driven cancellation
        // (Effect.timeout, Fiber.interrupt) cleans up before the exit
        // unwinds. A late inbound response then finds nothing in the
        // map and `resolve` returns false (no Deferred re-resolve).
        return yield* Effect.acquireUseRelease(
          // acquire: register the pending entry. Atomic Ref.update —
          // `resolve` and the Scope finalizer key off the same Ref, so
          // all writers serialize.
          Ref.update(pendingRef, (m) =>
            HashMap.set(m, id, { method, definition, deferred }),
          ),
          // use: write the frame and await the response. Write
          // failures fail the Deferred so a late inbound frame's
          // `Deferred.succeed` is a no-op via `Effect.ignore` on an
          // already-failed Deferred.
          () =>
            Effect.gen(function* () {
              yield* config.write(JSON.stringify(frame)).pipe(
                Effect.catchAll(() => {
                  const err = new NotConnectedError({
                    message: `JsonRpcClient: write failed for ${method}`,
                  });
                  return Deferred.fail(deferred, err).pipe(
                    Effect.ignore,
                    Effect.zipRight(Effect.fail<RpcCallError>(err)),
                  );
                }),
              );
              const result = yield* Deferred.await(deferred);
              const decoded = yield* decodeRpcResult(definition, result).pipe(
                Effect.mapError(
                  () =>
                    new RpcServerError({
                      code: JSON_RPC_RESERVED_CODES.InternalError,
                      message: `Invalid result for method: ${method}`,
                      data: result,
                    }),
                ),
              );
              return decoded as ResultOf<D>;
            }),
          // release: remove the entry. Idempotent — `HashMap.remove`
          // on an already-removed key is a no-op, so this is safe
          // whether `resolve` already removed it (success/error path)
          // or the Scope finalizer drained it (disconnect path).
          () => Ref.update(pendingRef, (m) => HashMap.remove(m, id)),
        );
      });

    return { call, resolve, failAllPending };
  });
