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
 * The client is built in `flatten` mode: its surface is the typed tag-keyed call
 * `<Tag>(tag, payload) => Effect<result, error>`. The result and error are
 * recovered PER TAG from the group's member — the engine decodes the wire error
 * against that method's own `errorSchema` union, so the call's error channel is
 * the method's typed tagged errors. The descriptor-driven `call(def, params)`
 * passes `def.name` (the branded wire tag) as the tag; the flat client's own
 * signature re-types the result + error per tag with no cast.
 */
import { RpcClient, type Rpc, type RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import { Deferred, Effect, Layer, Scope } from "effect";
import {
  makeClientChannelProtocol,
  type ChannelSink,
  type WireWrite,
} from "@moltzap/protocol";

/**
 * The typed tag-keyed call surface of the native flat client. `Tag` is a
 * member tag of the group's `Rpcs`; the result and error are recovered per tag
 * (the error includes the method's `errorSchema` union plus the engine's
 * `RpcClientError`). The high-level clients pass `definition.name` as `Tag`.
 */
export type NativeFlatCall<Rpcs extends Rpc.Any> = RpcClient.RpcClient.Flat<
  Rpcs,
  RpcClientError
>;

/**
 * Build the native client engine over one socket channel. Returns the typed
 * flat `call` plus a `Deferred` already resolved with the `c2s` sink. The engine
 * reader is forked into the provided `Scope`.
 */
export const buildNativeClient = <Rpcs extends Rpc.Any>(options: {
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  readonly write: WireWrite;
  readonly scope: Scope.Scope;
}): Effect.Effect<{
  readonly call: NativeFlatCall<Rpcs>;
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
    const call = yield* RpcClient.make(options.group, {
      flatten: true,
    }).pipe(Effect.provide(protocolLayer), Scope.extend(options.scope));
    const sink = yield* Deferred.await(sinkReady);
    return { call, sink };
  }).pipe(Effect.withSpan("buildNativeClient"));
