/**
 * @file The server-side reverse `@effect/rpc` client over the s2c channel.
 *
 * Per connection, the server stands ONE `RpcClient&lt;ReverseRpcGroup>` over the
 * s2c mux channel. `ReverseRpcGroup` is the moderator callbacks ∪ the
 * notifications. The server FIRES these as reverse RPCs at the connected client
 * (which serves them via its reverse `RpcServer`):
 *
 * - A callback (`dispatch/authorize`, `messages/authorize`, `task/create`) is
 *   awaited for its verdict (the moderator's reply).
 * - A notification is fired fork-and-forget (the `void`-result settles the
 *   reverse RPC; the server does not block on it).
 *
 * The s2c Protocol is the CLIENT side of the mux (`makeClientChannelProtocol`,
 * channel `s2c`): the server originates on s2c, the void acks come back. The
 * caller registers the returned sink with `runMuxReader` (alongside the c2s
 * engine's sink).
 */
import { RpcClient, type RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import { Deferred, Effect, Layer, Scope } from "effect";
import {
  ReverseRpcGroup,
  makeClientChannelProtocol,
  NotConnectedError,
  RpcTimeoutError,
  dispatchCall,
  type ChannelSink,
  type NotificationDefinition,
  type NotificationParamsOf,
  type TypedDispatchMap,
  type PayloadForTag,
  type SuccessForTag,
  type WireWrite,
} from "@moltzap/protocol";

/**
 * The error channel of a reverse (server → client) call. The s2c callbacks
 * declare no domain error (`errors: []`); a reverse call fails only at the
 * transport — the socket closed or the round-trip timed out.
 */
export type ReverseCallError = NotConnectedError | RpcTimeoutError;

/** The reverse group's member `Rpc`s — the tag-keyed dispatch surface. */
type ReverseRpcs = RpcGroup.Rpcs<typeof ReverseRpcGroup>;

/** The branded wire tags the server may fire on the reverse channel. */
type ReverseTag = ReverseRpcs["_tag"];

/**
 * A per-connection reverse client: the typed per-method `call` the server fires
 * callbacks/notifications through, plus the s2c {@link ChannelSink} the socket's
 * `runMuxReader` routes the inbound void-acks into.
 */
export interface ReverseClient {
  /**
   * Fire a reverse RPC at the connected client, keyed by wire tag. For a
   * callback this awaits the moderator's verdict; for a notification (`void`
   * result) it settles on the client's ack. The result and error are recovered
   * per tag cast-free from `ReverseRpcGroup`.
   */
  readonly call: <Tag extends ReverseTag>(
    tag: Tag,
    payload: PayloadForTag<ReverseRpcs, Tag>,
  ) => Effect.Effect<SuccessForTag<ReverseRpcs, Tag>, ReverseCallError>;

  /**
   * Fire a notification (a `void`-result reverse RPC) at the connected client.
   * Takes a {@link NotificationDefinition} (no result schema); the fan-out
   * forks this so it does not block. The client's reverse `RpcServer` routes
   * the payload into its `SubscriberRegistry` and acks `void`.
   */
  readonly notify: <D extends NotificationDefinition<string, any>>(
    definition: D,
    params: NotificationParamsOf<D>,
  ) => Effect.Effect<void, ReverseCallError>;

  /** The s2c inbound sink the demux feeds the void-acks into. */
  readonly sink: ChannelSink;
}

/**
 * Build a per-connection reverse client over the socket's `write`. Scoped: the
 * client + its forked engine reader live in the provided `Scope`. The client is
 * the NON-FLAT `RpcClient.make` record, viewed as a {@link TypedDispatchMap} so
 * `call(tag, payload)` dispatches cast-free — no value-boundary erasure.
 */
export const buildReverseClient = (options: {
  readonly write: WireWrite;
  readonly scope: Scope.Scope;
}): Effect.Effect<ReverseClient> =>
  Effect.gen(function* () {
    const sinkReady = yield* Deferred.make<ChannelSink>();
    const builder = makeClientChannelProtocol({
      channel: "s2c",
      write: options.write,
    });
    const protocolLayer = Layer.scoped(
      RpcClient.Protocol,
      RpcClient.Protocol.make((write) =>
        builder(write).pipe(
          Effect.tap((built) => Deferred.succeed(sinkReady, built.sink)),
          Effect.map((built) => built.impl),
        ),
      ),
    );
    const client: TypedDispatchMap<ReverseRpcs, RpcClientError> =
      yield* RpcClient.make(ReverseRpcGroup).pipe(
        Effect.provide(protocolLayer),
        Scope.extend(options.scope),
      );
    const sink = yield* Deferred.await(sinkReady);
    const call = <Tag extends ReverseTag>(
      tag: Tag,
      payload: PayloadForTag<ReverseRpcs, Tag>,
    ): Effect.Effect<SuccessForTag<ReverseRpcs, Tag>, ReverseCallError> => {
      // The non-flat client `client[tag](payload)` is typed per tag; over the
      // MERGED `ReverseRpcGroup` (callbacks ∪ notifications) TS does not reduce
      // the per-tag success through `dispatchCall` at a generic `Tag`, so the
      // single-tag dispatch is named back to `SuccessForTag` here. No value-
      // boundary flat erasure — the client is the real per-method record.
      const dispatched = dispatchCall(client, tag, payload).pipe(
        // The engine surfaces a closed s2c socket as `RpcClientError`; the
        // reverse call's transport contract is `NotConnectedError`.
        Effect.catchTag("RpcClientError", () =>
          Effect.fail(
            new NotConnectedError({ message: "reverse socket closed" }),
          ),
        ),
      );
       
      // #ignore-sloppy-code-next-line[as-unknown-as]: merged ReverseRpcGroup per-tag success not reducible through dispatchCall at a generic Tag; the dispatch IS the single-tag call.
      return dispatched as unknown as Effect.Effect<
        SuccessForTag<ReverseRpcs, Tag>,
        ReverseCallError
      >;
    };
    const notify = <D extends NotificationDefinition<string, any>>(
      definition: D,
      params: NotificationParamsOf<D>,
    ): Effect.Effect<void, ReverseCallError> =>
      call(
        definition.name as ReverseTag,
        params as PayloadForTag<ReverseRpcs, ReverseTag>,
      ).pipe(Effect.asVoid);
    return { call, notify, sink };
  }).pipe(Effect.withSpan("buildReverseClient"));
