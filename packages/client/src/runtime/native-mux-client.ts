/**
 * @file The client-side native `@effect/rpc` engine over the channel-mux
 * transport (`@moltzap/protocol transport/native-mux.ts`).
 *
 * One physical WebSocket carries the `c2s` outbound RPC channel (this module)
 * and, after the callback role-inversion, the `s2c` server-originated callback
 * channel. This module stands `RpcClient.make` over a `RpcClient.Protocol`
 * built from `makeClientChannelProtocol({ channel: "c2s", write })`, and
 * registers the `c2s` sink so `runMuxReader` routes inbound `{ch,f}` envelopes
 * back into the client engine.
 *
 * The client is built in `flatten` mode, so its surface is one tag-keyed call
 * function `(tag, payload) => Effect<result, RpcClientError>` — the descriptor-
 * driven `.call(def, params)` the high-level clients already speak maps onto it
 * by passing `def.name` (the branded wire tag) as the tag.
 */
import { RpcClient, type Rpc, type RpcGroup } from "@effect/rpc";
import { Deferred, Effect, Layer, Scope } from "effect";
import {
  makeClientChannelProtocol,
  type ChannelSink,
  type ParamsOf,
  type ResultOf,
  type RpcCallError,
  type RpcDefinition,
  type WireWrite,
} from "@moltzap/protocol";

/**
 * The flat client's tag-keyed call function shape: `(tag, payload) => Effect`.
 * The `RpcClient.Flat` type erases to this at the value boundary, so the
 * descriptor-driven `call` re-types its result per definition.
 */
type FlatCall = (
  tag: string,
  payload: unknown,
) => Effect.Effect<unknown, RpcCallError>;

/**
 * Build the native client engine over one socket channel. Returns the
 * descriptor-driven connection plus a `Deferred` already resolved with the
 * `c2s` sink. The engine reader is forked into the provided `Scope`.
 */
export const buildNativeClient = <Rpcs extends Rpc.Any>(options: {
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  readonly write: WireWrite;
  readonly scope: Scope.Scope;
}): Effect.Effect<{
  readonly call: <D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, RpcCallError>;
  readonly sink: ChannelSink;
}> =>
  Effect.gen(function* () {
    const sinkReady = yield* Deferred.make<ChannelSink>();
    const builder = makeClientChannelProtocol({
      channel: "c2s",
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
    const flat = yield* RpcClient.make(options.group, {
      flatten: true,
    }).pipe(
      Effect.provide(protocolLayer),
      Scope.extend(options.scope),
    );
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
    return { call, sink };
  }).pipe(Effect.withSpan("buildNativeClient"));
