/**
 * @file The `@effect/rpc` server engine over the channel-multiplexed
 * transport (`transport/mux.ts`).
 *
 * `RpcServer.make`/`RpcServer.layer` bind {@link WsServerEngineRpcGroup}
 * to a `RpcServer.Protocol` built from the server-side mux channel
 * (`makeServerChannelProtocol`). The engine reads inbound `FromClientEncoded`
 * frames the mux demuxes off the c→s channel, dispatches each to the matching
 * `WsServerEngineRpcGroup.toLayer` handler, and writes the `FromServerEncoded`
 * reply back through the same channel's Parser.
 *
 * A request's authentication reaches its handler as a Context service: each
 * authenticated member carries its OWN `*AuthMw` middleware (the per-method
 * principal-kind gate + caps, `auth-middleware.ts`), whose `provides` is that
 * method's `AuthContext` proof tag. The proof tags live in the protocol
 * (alongside the descriptors they project from); the runtime that resolves a
 * `clientId` to its connection arm, narrows it, and runs the caps is supplied by
 * the server as a per-socket `Layer` over each `*AuthMw`, preserving the one-way
 * protocol→server edge.
 *
 * ```mermaid
 * flowchart LR
 *   socket["c→s mux channel"] -->|FromClientEncoded| ENG[RpcServer engine]
 *   ENG -->|clientId, rpc, payload, headers| MW["per-method *AuthMw"]
 *   MW -->|provides the method AuthContext proof| H["ServerEngineRpcGroup.toLayer handler"]
 *   H -->|FromServerEncoded| socket
 * ```
 */
import { RpcServer } from "@effect/rpc";
import { Deferred, Effect, Layer, type Mailbox } from "effect";
import {
  makeServerChannelProtocol,
  type ChannelSink,
  type WireWrite,
} from "../transport/mux.js";
import { WsServerEngineRpcGroup } from "./server-engine-group.js";

/**
 * Build the `RpcServer.Protocol` layer over one server-side mux
 * channel. `RpcServer.Protocol.make` hands the engine's inbound `write`
 * injector to {@link makeServerChannelProtocol}'s builder, which returns the
 * protocol impl record (the engine binds to) plus the channel sink (the mux
 * demux feeds decoded inbound frames into). Only the impl crosses into the
 * `Protocol` Tag; the built {@link ChannelSink} is fulfilled into the
 * caller-provided `sinkReady` Deferred so the live connection's
 * `runMuxReader` can route inbound `c2s` chunks into the engine.
 *
 * The sink's `inject` closes over the SAME `write` injector the engine handed
 * the builder, so a chunk routed to the sink enters the engine's dispatch
 * loop. The Deferred handoff is necessary because the sink is only knowable
 * after the engine builds the Protocol (the `write` injector does not exist
 * until then), and `runMuxReader` must register it before the socket reader
 * forks.
 *
 * `write` is the raw-write surface of the shared socket (one call writes one
 * enveloped chunk; the live connection passes `Socket.Socket["writer"]`).
 * `disconnects` is the Mailbox the live connection offers a client id to on
 * socket close, so the engine runs per-client teardown.
 */
export const makeServerProtocolLayer = (options: {
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
  readonly sinkReady: Deferred.Deferred<ChannelSink>;

  /**
   * Which mux channel this server engine binds. The live server's inbound
   * engine binds `c2s`; the client's reverse notification/callback server binds
   * `s2c`. Defaults to `c2s` (the server inbound engine, the common case).
   */
  readonly channel?: "c2s" | "s2c";
}): Layer.Layer<RpcServer.Protocol> => {
  const builder = makeServerChannelProtocol({
    channel: options.channel ?? "c2s",
    write: options.write,
    disconnects: options.disconnects,
  });
  return Layer.scoped(
    RpcServer.Protocol,
    RpcServer.Protocol.make((write) =>
      builder(write).pipe(
        Effect.tap((built) => Deferred.succeed(options.sinkReady, built.sink)),
        Effect.map((built) => built.impl),
      ),
    ),
  );
};

/**
 * The server engine layer for {@link WsServerEngineRpcGroup} — the WS-dispatched
 * members, each carrying its per-method `*AuthMw`. Binding a group whose members
 * lacked the `*AuthMw` gate would run methods with no authorization gate. The
 * server-wiring guard canary (`server-engine.types-check.ts`) pins that this
 * layer's requirement channel demands the per-method `*AuthMw`.
 *
 * `RpcServer.layer(group)` runs the dispatch loop over whatever
 * `RpcServer.Protocol` is in scope; there is no `RpcServer.toLayer`. Its
 * requirement channel is
 * `RpcServer.Protocol | Rpc.ToHandler&lt;WsServerEngineRpcGroup&gt;` plus every
 * member's `*AuthMw` — the live connection provides the Protocol via
 * {@link makeServerProtocolLayer}, the handler bodies via
 * `WsServerEngineRpcGroup.toLayer(serverHandlers)`, and each `*AuthMw`
 * runtime via its per-socket server-supplied `Layer`
 * (`auth-middleware-layers.ts`).
 */
export const ServerEngineLayer = RpcServer.layer(WsServerEngineRpcGroup);
