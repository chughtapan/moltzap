/**
 * @file The native `@effect/rpc` server engine over the channel-multiplexed
 * transport (`transport/native-mux.ts`).
 *
 * `RpcServer.make`/`RpcServer.layer` bind {@link rpc-method-groups.ServerRpcGroup}
 * to a `RpcServer.Protocol` built from the server-side native-mux channel
 * (`makeServerChannelProtocol`). The engine reads inbound `FromClientEncoded`
 * frames the mux demuxes off the c→s channel, dispatches each to the matching
 * `ServerRpcGroup.toLayer` handler, and writes the `FromServerEncoded` reply
 * back through the same channel's Parser.
 *
 * The request's authenticated principal reaches a handler as a Context
 * service: {@link PrincipalResolution} is the `@effect/rpc` middleware
 * descriptor that provides `CurrentPrincipal`. Its descriptor lives here
 * (protocol-owned, alongside the `CurrentPrincipal` Tag it provides); the
 * runtime that resolves a `clientId` to its connection arm and narrows it to
 * the 2-arm {@link CurrentPrincipal.Principal} is supplied by the server as a
 * `Layer` over this descriptor, preserving the one-way protocol→server edge.
 *
 * ```mermaid
 * flowchart LR
 *   socket["c→s native-mux channel"] -->|FromClientEncoded| ENG[RpcServer engine]
 *   ENG -->|clientId, rpc, payload, headers| MW[PrincipalResolution]
 *   MW -->|provides CurrentPrincipal| H["ServerRpcGroup.toLayer handler"]
 *   H -->|FromServerEncoded| socket
 * ```
 */
import { RpcServer } from "@effect/rpc";
import { Effect, Layer, type Mailbox } from "effect";
import { makeServerChannelProtocol, type WireWrite } from "./native-mux.js";
import { ServerEngineRpcGroup } from "./server-engine-group.js";

export { PrincipalResolution } from "./server-engine-group.js";

/**
 * Build the `RpcServer.Protocol` layer over one server-side native-mux
 * channel. `RpcServer.Protocol.make` hands the engine's inbound `write`
 * injector to {@link makeServerChannelProtocol}'s builder, which returns the
 * protocol impl record (the engine binds to) plus the channel sink (the mux
 * demux feeds decoded inbound frames into). Only the impl crosses into the
 * `Protocol` Tag here; the live connection owns the sink registration and the
 * `disconnects` Mailbox wiring.
 *
 * `write` is the raw-write surface of the shared socket (one call writes one
 * enveloped chunk; the live connection passes `Socket.Socket["writer"]`).
 * `disconnects` is the Mailbox the live connection offers a client id to on
 * socket close, so the engine runs per-client teardown.
 */
export const makeServerProtocolLayer = (options: {
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
}): Layer.Layer<RpcServer.Protocol> => {
  const builder = makeServerChannelProtocol({
    channel: "c2s",
    write: options.write,
    disconnects: options.disconnects,
  });
  return Layer.scoped(
    RpcServer.Protocol,
    RpcServer.Protocol.make((write) =>
      builder(write).pipe(Effect.map((built) => built.impl)),
    ),
  );
};

/**
 * The native server engine layer for {@link ServerEngineRpcGroup} — the
 * middleware-attached group, NOT the un-gated `ServerRpcGroup`. Binding
 * `ServerRpcGroup` here would run every method with no `PrincipalResolution`
 * gate, an authorization bypass; the server-wiring guard canary
 * (`server-engine-group.types-check.ts`) pins that this layer's requirement
 * channel demands `PrincipalResolution`.
 *
 * `RpcServer.layer(group)` runs the dispatch loop over whatever
 * `RpcServer.Protocol` is in scope; there is no `RpcServer.toLayer`. Its
 * requirement channel is
 * `RpcServer.Protocol | Rpc.ToHandler&lt;ServerEngineRpcGroup&gt;` plus
 * `PrincipalResolution` — the live connection provides the Protocol via
 * {@link makeServerProtocolLayer}, the handler bodies via
 * `ServerEngineRpcGroup.toLayer(...)`, and the {@link PrincipalResolution}
 * middleware runtime via its per-socket server-supplied `Layer`.
 */
export const ServerEngineLayer = RpcServer.layer(ServerEngineRpcGroup);
