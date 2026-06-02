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
import { RpcClient } from "@effect/rpc";
import { Deferred, Effect, Layer, Scope } from "effect";
import {
  ReverseRpcGroup,
  makeClientChannelProtocol,
  type ChannelSink,
  type NotificationDefinition,
  type NotificationParamsOf,
  type ParamsOf,
  type ResultOf,
  type RpcCallError,
  type RpcDefinition,
  type WireWrite,
} from "@moltzap/protocol";

/** The flat reverse client's tag-keyed call function. */
type FlatCall = (
  tag: string,
  payload: unknown,
) => Effect.Effect<unknown, RpcCallError>;

/**
 * A per-connection reverse client: the descriptor-driven `call` the server
 * fires callbacks/notifications through, plus the s2c {@link ChannelSink} the
 * socket's `runMuxReader` routes the inbound void-acks into.
 */
export interface ReverseClient {
  /**
   * Fire a reverse RPC at the connected client. For a callback this awaits the
   * moderator's verdict; for a notification (`void` result) it settles on the
   * client's ack. The caller forks the notification fire so the fan-out does
   * not block on the round-trip.
   */
  readonly call: <D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, RpcCallError>;

  /**
   * Fire a notification (a `void`-result reverse RPC) at the connected client.
   * Takes a {@link NotificationDefinition} (no result schema); the fan-out
   * forks this so it does not block. The client's reverse `RpcServer` routes
   * the payload into its `SubscriberRegistry` and acks `void`.
   */
  readonly notify: <D extends NotificationDefinition<string, any>>(
    definition: D,
    params: NotificationParamsOf<D>,
  ) => Effect.Effect<void, RpcCallError>;

  /** The s2c inbound sink the demux feeds the void-acks into. */
  readonly sink: ChannelSink;
}

/**
 * Build a per-connection reverse client over the socket's `write`. Scoped: the
 * client + its forked engine reader live in the provided `Scope`.
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
    const flat = yield* RpcClient.make(ReverseRpcGroup, {
      flatten: true,
    }).pipe(Effect.provide(protocolLayer), Scope.extend(options.scope));
    // eslint-disable-next-line agent-code-guard/as-unknown-as -- RpcClient.Flat erases to a tag-keyed call fn at the value boundary; the descriptor-driven call re-types its result per definition.
    const flatCall = flat as unknown as FlatCall; // #ignore-sloppy-code[as-unknown-as]: flat RpcClient value-boundary erasure to the tag-keyed call shape.
    const sink = yield* Deferred.await(sinkReady);
    const call = <D extends RpcDefinition<string, any, any>>(
      definition: D,
      params: ParamsOf<D>,
    ): Effect.Effect<ResultOf<D>, RpcCallError> =>
      flatCall(definition.name, params) as Effect.Effect<
        ResultOf<D>,
        RpcCallError
      >;
    const notify = <D extends NotificationDefinition<string, any>>(
      definition: D,
      params: NotificationParamsOf<D>,
    ): Effect.Effect<void, RpcCallError> =>
      flatCall(definition.name, params).pipe(Effect.asVoid);
    return { call, notify, sink };
  }).pipe(Effect.withSpan("buildReverseClient"));
