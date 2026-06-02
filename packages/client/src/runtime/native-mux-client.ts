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
 * The client is the NON-FLAT `RpcClient` — a per-method record keyed by wire
 * tag, each value `(payload) => Effect&lt;result, error>`. The engine recovers the
 * result and the method's `errorSchema` error union per tag, so a call's error
 * channel is the method's typed tagged errors plus the engine's
 * `RpcClientError`. The record is consumed as a {@link TypedDispatchMap}: a
 * caller indexes `client[tag](payload)` cast-free at a concrete tag (see
 * `typed-dispatch.ts → dispatchCall`).
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
 * Build the native client engine over one socket channel. Returns the non-flat
 * per-method `RpcClient` (the record the high-level clients view as a
 * `TypedDispatchMap` and dispatch `client[tag](payload)` through cast-free) plus
 * a `Deferred` already resolved with the `c2s` sink. The engine reader is forked
 * into the provided `Scope`.
 *
 * The return is the raw `RpcClient.make` type, not a `TypedDispatchMap`: the
 * mapped shape only conforms once `Rpcs` is the caller's CONCRETE group (the
 * `From` key-remapping does not reduce against an abstract `Rpcs`). The caller
 * binds the result into a concrete `TypedDispatchMap&lt;ConcreteRpcs, …>` field.
 */
export const buildNativeClient = <Rpcs extends Rpc.Any>(options: {
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  readonly write: WireWrite;
  readonly scope: Scope.Scope;
}): Effect.Effect<{
  readonly client: RpcClient.RpcClient<Rpcs, RpcClientError>;
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
    const client = yield* RpcClient.make(options.group).pipe(
      Effect.provide(protocolLayer),
      Scope.extend(options.scope),
    );
    const sink = yield* Deferred.await(sinkReady);
    return { client, sink };
  }).pipe(Effect.withSpan("buildNativeClient"));
