/**
 * @file The cast-free typed dispatch over a non-flat `@effect/rpc` client.
 *
 * A non-flat `RpcClient.make(group)` is a per-method record keyed by wire tag;
 * each value is `(payload) => Effect&lt;success, error>` with the result and error
 * recovered PER TAG. {@link TypedDispatchMap} names that record shape as a
 * mapped type, and {@link dispatchCall} indexes it at a concrete tag `K` so the
 * result and the method's `errorSchema` error union flow with no cast.
 *
 * This is the cast-free bridge the redesign turns on: a literal-keyed total map.
 * A caller that has a generic tag `K extends Rpcs["_tag"]` dispatches through it
 * without the flat-client value-boundary erasure the old descriptor-driven call
 * needed.
 */
import type { Rpc } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import { Effect } from "effect";

/** The `Rpc` member of `Rpcs` whose tag is `K`. */
export type RpcForTag<
  Rpcs extends Rpc.Any,
  K extends Rpcs["_tag"],
> = Rpc.ExtractTag<Rpcs, K>;

/** The payload type one tag accepts. */
export type PayloadForTag<
  Rpcs extends Rpc.Any,
  K extends Rpcs["_tag"],
> = Rpc.PayloadConstructor<RpcForTag<Rpcs, K>>;

/** The success type one tag returns. */
export type SuccessForTag<
  Rpcs extends Rpc.Any,
  K extends Rpcs["_tag"],
> = Rpc.Success<RpcForTag<Rpcs, K>>;

/** The method's own tagged-error union for one tag (from its `errorSchema`). */
export type ErrorForTag<
  Rpcs extends Rpc.Any,
  K extends Rpcs["_tag"],
> = Rpc.Error<RpcForTag<Rpcs, K>>;

/**
 * The per-method dispatch map a non-flat `RpcClient.make(group)` conforms to:
 * keyed by every member tag, each value the method's typed call
 * `(payload) => Effect&lt;success, methodErrors | E>`. `E` is the engine's
 * transport error (`RpcClientError`) the caller folds into its own channel.
 */
export type TypedDispatchMap<Rpcs extends Rpc.Any, E> = {
  readonly [K in Rpcs["_tag"]]: (
    payload: PayloadForTag<Rpcs, K>,
  ) => Effect.Effect<SuccessForTag<Rpcs, K>, ErrorForTag<Rpcs, K> | E>;
};

/**
 * Dispatch one call through the typed map at tag `K` — cast-free. `map[tag]` is
 * the method's typed call; applying it to `payload` yields the per-tag result +
 * error. Leaf call sites pass a literal tag and recover the precise types; a
 * caller generic over `K` keeps the correlation because the map is keyed on the
 * literal tag, not on a widened def union.
 */
export function dispatchCall<Rpcs extends Rpc.Any, E, K extends Rpcs["_tag"]>(
  map: TypedDispatchMap<Rpcs, E>,
  tag: K,
  payload: PayloadForTag<Rpcs, K>,
): Effect.Effect<SuccessForTag<Rpcs, K>, ErrorForTag<Rpcs, K> | E> {
  return map[tag](payload);
}

/**
 * Bind a non-flat `RpcClient` (viewed as a {@link TypedDispatchMap}) into a
 * per-method `call(tag, payload)` that folds the engine's transport-level
 * `RpcClientError` (a closed socket) into the caller's own `TransportError`.
 *
 * Generic over `Rpcs`: the body type-checks `dispatchCall` against the abstract
 * `SuccessForTag&lt;Rpcs, Tag>`, so the per-tag success reduces at every concrete
 * instantiation — including the combined callback ∪ notification group — with
 * no value-boundary cast. Every endpoint that stands a non-flat client (the
 * agent + app clients, the server's reverse client) shares this one bridge, so
 * the transport-error fold is written once.
 */
export function makeTypedTransportCall<Rpcs extends Rpc.Any, TransportError>(
  client: TypedDispatchMap<Rpcs, RpcClientError>,
  onTransportError: () => TransportError,
): <Tag extends Rpcs["_tag"]>(
  tag: Tag,
  payload: PayloadForTag<Rpcs, Tag>,
) => Effect.Effect<
  SuccessForTag<Rpcs, Tag>,
  ErrorForTag<Rpcs, Tag> | TransportError
> {
  return (tag, payload) =>
    dispatchCall(client, tag, payload).pipe(
      Effect.catchTag("RpcClientError", () => Effect.fail(onTransportError())),
    );
}
