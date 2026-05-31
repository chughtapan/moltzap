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
import { RpcMiddleware, RpcServer } from "@effect/rpc";
import { Effect, Layer, type Mailbox } from "effect";
import { CurrentPrincipal } from "./current-principal.js";
import { makeServerChannelProtocol, type WireWrite } from "./native-mux.js";
import { ServerRpcGroup } from "./rpc-method-groups.js";

/**
 * The `@effect/rpc` middleware descriptor that provides the request's
 * authenticated {@link CurrentPrincipal.Principal} into every handler's
 * Context. `provides: CurrentPrincipal` makes the middleware's service value
 * the 2-arm principal, so a handler reads identity via `yield* CurrentPrincipal`
 * with no `ctx` parameter and no cast.
 *
 * The descriptor is protocol-owned because the Tag it provides
 * (`CurrentPrincipal`) is protocol-owned; the implementation that resolves a
 * `clientId` to its live connection arm (via the server's `ConnectionManager`)
 * and narrows the 3-arm connection union to the 2-arm principal is a server
 * concern, supplied as a `Layer` over this Tag. The middleware impl shape
 * `@effect/rpc` derives from this descriptor is
 * `({ clientId, rpc, payload, headers }) => Effect&lt;Principal&gt;` —
 * payload-only, no `ctx`.
 */
export class PrincipalResolution extends RpcMiddleware.Tag<PrincipalResolution>()(
  "@moltzap/protocol/PrincipalResolution",
  { provides: CurrentPrincipal },
) {}

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
 * The native server engine layer for {@link ServerRpcGroup}.
 * `RpcServer.layer(group)` runs the dispatch loop over whatever
 * `RpcServer.Protocol` is in scope; there is no `RpcServer.toLayer`. Its
 * requirement channel is
 * `RpcServer.Protocol | Rpc.ToHandler&lt;ServerRpcGroup&gt;` plus the group's
 * Context/Middleware — the live connection provides the
 * Protocol via {@link makeServerProtocolLayer}, the handler bodies via
 * `ServerRpcGroup.toLayer(...)`, and the {@link PrincipalResolution} middleware
 * runtime via its server-supplied `Layer`.
 */
export const ServerEngineLayer = RpcServer.layer(ServerRpcGroup);
