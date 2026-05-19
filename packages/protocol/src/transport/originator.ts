import { Deferred, Effect, HashMap, Option, Ref, Scope } from "effect";
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

interface PendingCall {
  readonly method: string;
  readonly definition: AnyRpcDefinition;
  readonly deferred: Deferred.Deferred<unknown, RpcCallError>;
}

export type RpcCallError =
  | NotConnectedError
  | RpcServerError
  | RegisteredTaggedError;

/**
 * Originator side of a JSON-RPC connection. Scope-bound: closing the
 * scope runs `failAllPending(NotConnectedError)`. Caller owns timeouts.
 */
export interface Originator {
  readonly call: <D extends AnyRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, RpcCallError>;
  readonly resolve: (frame: ResponseFrame) => Effect.Effect<boolean>;
  readonly failAllPending: (error: NotConnectedError) => Effect.Effect<void>;
}

interface OriginatorConfig {
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}

interface OriginatorRefs {
  readonly counterRef: Ref.Ref<number>;
  readonly pendingRef: Ref.Ref<HashMap.HashMap<JsonRpcId, PendingCall>>;
}

function incrementCounter(n: number): readonly [number, number] {
  const value = n + 1;
  return [value, value] as const;
}

function addPendingEntry(
  id: JsonRpcId,
  entry: PendingCall,
): (
  pending: HashMap.HashMap<JsonRpcId, PendingCall>,
) => HashMap.HashMap<JsonRpcId, PendingCall> {
  return (pending) => HashMap.set(pending, id, entry);
}

function takePendingEntry(
  id: JsonRpcId,
): (
  pending: HashMap.HashMap<JsonRpcId, PendingCall>,
) => readonly [
  Option.Option<PendingCall>,
  HashMap.HashMap<JsonRpcId, PendingCall>,
] {
  return (pending) => [HashMap.get(pending, id), HashMap.remove(pending, id)];
}

function wireErrorToRpcCallError(error: {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}): RpcCallError {
  const cls = errorClassFor(error.code);
  if (cls === undefined) {
    return new RpcServerError({
      code: error.code,
      message: error.message,
      data: error.data,
    });
  }
  // The wire-error registry stores the class factory keyed by code; the
  // constructor produces a concrete tagged-error instance whose runtime tag
  // matches one of the union arms in `RegisteredTaggedError`. The type system
  // can't see through the open-ended `new (...) => { _tag: string }` factory
  // shape, so the cast bridges the static factory to the closed runtime union.
  // The `data` argument is forwarded so any payload set by the server reaches
  // the typed instance rather than being dropped (#511).
  return new cls({ data: error.data } as never) as RegisteredTaggedError;
}

function failAllPendingFromRef(
  pendingRef: OriginatorRefs["pendingRef"],
  error: NotConnectedError,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const drained = yield* Ref.getAndSet(
      pendingRef,
      HashMap.empty<JsonRpcId, PendingCall>(),
    );
    for (const [, entry] of HashMap.entries(drained)) {
      yield* Deferred.fail(entry.deferred, error).pipe(Effect.ignore);
    }
  });
}

function resolvePendingFrame(
  pendingRef: OriginatorRefs["pendingRef"],
  frame: ResponseFrame,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (frame.id === null) return false;
    const removed = yield* Ref.modify(pendingRef, takePendingEntry(frame.id));
    return yield* Option.match(removed, {
      onNone: () => Effect.succeed(false),
      onSome: (entry) => completePendingFrame(entry, frame),
    });
  });
}

function completePendingFrame(
  entry: PendingCall,
  frame: ResponseFrame,
): Effect.Effect<boolean> {
  const { deferred } = entry;
  if ("error" in frame && frame.error !== undefined) {
    return Deferred.fail(deferred, wireErrorToRpcCallError(frame.error)).pipe(
      Effect.ignore,
      Effect.as(true),
    );
  }
  if ("result" in frame) {
    return Deferred.succeed(deferred, frame.result).pipe(
      Effect.ignore,
      Effect.as(true),
    );
  }
  return Effect.succeed(true);
}

function failWrite(
  deferred: Deferred.Deferred<unknown, RpcCallError>,
  method: string,
): Effect.Effect<never, RpcCallError> {
  const err = new NotConnectedError({
    message: `Originator: write failed for ${method}`,
  });
  return Deferred.fail(deferred, err).pipe(
    Effect.ignore,
    Effect.zipRight(Effect.fail<RpcCallError>(err)),
  );
}

function writeRequestFrame(
  config: OriginatorConfig,
  raw: string,
  method: string,
  deferred: Deferred.Deferred<unknown, RpcCallError>,
): Effect.Effect<void, RpcCallError> {
  return config
    .write(raw)
    .pipe(Effect.catchAll(() => failWrite(deferred, method)));
}

function decodeCallResult<D extends AnyRpcDefinition>(
  definition: D,
  method: string,
  result: unknown,
): Effect.Effect<ResultOf<D>, RpcCallError> {
  return decodeRpcResult(definition, result).pipe(
    Effect.catchTag("RpcResultDecodeError", () =>
      Effect.fail(
        new RpcServerError({
          code: JSON_RPC_RESERVED_CODES.InternalError,
          message: `Invalid result for method: ${method}`,
          data: result,
        }),
      ),
    ),
    Effect.map((decoded) => decoded as ResultOf<D>),
  );
}

function callWithRefs<D extends AnyRpcDefinition>(
  config: OriginatorConfig,
  refs: OriginatorRefs,
  definition: D,
  params: ParamsOf<D>,
): Effect.Effect<ResultOf<D>, RpcCallError> {
  return Effect.gen(function* () {
    const method = definition.name;
    const next = yield* Ref.modify(refs.counterRef, incrementCounter);
    const frame = requestFrame(
      `${config.idPrefix}-${next}`,
      definition,
      params,
    );
    const id = frame.id;
    const deferred = yield* Deferred.make<unknown, RpcCallError>();
    yield* Ref.update(
      refs.pendingRef,
      addPendingEntry(id, { method, definition, deferred }),
    );
    return yield* Effect.gen(function* () {
      yield* writeRequestFrame(config, JSON.stringify(frame), method, deferred);
      const result = yield* Deferred.await(deferred);
      return yield* decodeCallResult(definition, method, result);
    }).pipe(
      Effect.ensuring(
        Ref.update(refs.pendingRef, (pending) => HashMap.remove(pending, id)),
      ),
    );
  });
}

export const makeOriginator = (config: {
  readonly write: (raw: string) => Effect.Effect<void, unknown>;
  readonly idPrefix: string;
}): Effect.Effect<Originator, never, Scope.Scope> =>
  Effect.gen(function* () {
    const counterRef = yield* Ref.make(0);
    const pendingRef = yield* Ref.make(HashMap.empty<JsonRpcId, PendingCall>());
    const refs: OriginatorRefs = { counterRef, pendingRef };
    const failAllPending = (error: NotConnectedError): Effect.Effect<void> =>
      failAllPendingFromRef(pendingRef, error);

    yield* Effect.addFinalizer(() =>
      failAllPending(
        new NotConnectedError({
          message: "Originator scope closed with pending calls",
        }),
      ),
    );

    const resolve = (frame: ResponseFrame): Effect.Effect<boolean> =>
      resolvePendingFrame(pendingRef, frame);

    const call = <D extends AnyRpcDefinition>(
      definition: D,
      params: ParamsOf<D>,
    ): Effect.Effect<ResultOf<D>, RpcCallError> =>
      // Issue #310 contract: insert the pending entry before writing and
      // remove it on success, error, or interrupt. A late inbound response
      // then finds nothing in the map and `resolve` returns false (no
      // Deferred re-resolve).
      callWithRefs(config, refs, definition, params);

    return { call, resolve, failAllPending };
  }).pipe(Effect.withSpan("makeOriginator"));
