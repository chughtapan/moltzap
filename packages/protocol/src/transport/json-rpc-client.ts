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
              : // `cls` accepts `RpcErrorPayload` by construction (every
                // registered class extends `Data.TaggedError(<tag>)<RpcErrorPayload>`).
                // The cast to `RegisteredTaggedError` bridges the registry's
                // open factory shape (`{ _tag: string }`) to the closed
                // runtime union; the runtime invariant — every registered
                // class is a union arm — is asserted at registration, not
                // at decode.
                (new cls({ data: frame.error.data }) as RegisteredTaggedError);
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

        // Issue #310 contract: insert the pending entry before writing
        // and remove it on success, error, or interrupt. A late inbound
        // response then finds nothing in the map and `resolve` returns
        // false (no Deferred re-resolve).
        yield* Ref.update(pendingRef, (m) =>
          HashMap.set(m, id, { method, definition, deferred }),
        );

        return yield* Effect.gen(function* () {
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
            Effect.catchTag("RpcResultDecodeError", () =>
              Effect.fail(
                new RpcServerError({
                  code: JSON_RPC_RESERVED_CODES.InternalError,
                  message: `Invalid result for method: ${method}`,
                  data: result,
                }),
              ),
            ),
          );
          return decoded as ResultOf<D>;
        }).pipe(
          Effect.ensuring(Ref.update(pendingRef, (m) => HashMap.remove(m, id))),
        );
      });

    return { call, resolve, failAllPending };
  }).pipe(Effect.withSpan("makeJsonRpcClient"));
