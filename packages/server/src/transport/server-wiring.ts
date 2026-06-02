/**
 * @file Per-socket `@effect/rpc` server engine composition.
 *
 * Stands one `RpcServer&lt;WsServerEngineRpcGroup>` per WebSocket inside the
 * connection's `Scope`. The engine needs three per-socket layers, each
 * closing over THIS socket's `connId`:
 *
 * - `makeServerProtocolLayer({ write, disconnects })` — the `c2s` Protocol
 *   binding the mux channel to the engine's inbound/outbound frame path.
 * - the 26 `make*AuthMwLayer(connId)` impl Layers — one per authenticated WS
 *   method, each peeking the live arm and running the method's principal gate
 *   + caps (`auth-middleware-layers.ts`). Merged via `Layer.mergeAll`.
 * - `makeConnectionTagLayer(connId)` — the request-scoped full-arm read the
 *   handler bodies (`server-handlers-runtime.ts → agentArm/appArm`)
 *   type against, resolved per access off `ConnectionManagerTag`.
 *
 * These are NEVER app-memoized: each closes over `connId`, so two concurrent
 * sockets stand two disjoint engines with disjoint auth/connection arms. The
 * `MUX_CLIENT_ID = 0` the mux reports per socket load-bears nothing — the
 * closed-over `connId` is the only connection key. The 2-concurrent-socket
 * cross-principal isolation test is the regression proof.
 */
import type { RpcGroup } from "@effect/rpc";
import { Effect, Layer, type Deferred, type Mailbox } from "effect";
import {
  ServerEngineLayer,
  WsServerEngineRpcGroup,
  makeServerProtocolLayer,
  type ChannelSink,
  type WireWrite,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import { ConnectionManagerTag, ConnectionTag } from "../app/layers.js";
import { serverHandlers } from "../app/server-handlers.js";
import { peekLiveArm } from "./principal-gate.js";
import { makeCapMiddlewareLayers } from "./auth-middleware-layers.js";

/**
 * The request-scoped `ConnectionTag` for ONE socket. `Layer.effect` resolves
 * the layer body once per `RpcServer` build (per socket); the body reads the
 * live arm off `ConnectionManagerTag` keyed by the closed-over `connId`. The
 * arm read is `peekLiveArm`, which returns the FULL live `Connection` (any
 * arm), so a handler body narrowing on `_tag` after its `*AuthMw` gate
 * sees the arm the gate already promoted.
 *
 * `ConnectionTag` carries the socket-fixed `connId` and resolves the arm at
 * build time. The per-request principal fields a handler narrows on
 * (`agentId`/`ownerUserId`) ride the `*AuthMw` proof, not this tag; this tag is
 * the full-arm read for the handler-body context the proof's `PrincipalForKind`
 * projection omits.
 */
const makeConnectionTagLayer = (
  connId: ConnectionId,
): Layer.Layer<ConnectionTag, never, ConnectionManagerTag> =>
  Layer.effect(
    ConnectionTag,
    ConnectionManagerTag.pipe(
      Effect.flatMap((manager) => peekLiveArm(manager, connId)),
    ),
  );

/**
 * Merge the 26 per-method `*AuthMw` impl Layers for one socket. Each closes
 * over `connId` and requires `ConnectionManagerTag` (the cap mws also require
 * the cap obtains' service env); `Layer.mergeAll` (inside
 * {@link makeCapMiddlewareLayers}) unions their outputs (the principal gate +
 * the cap middleware Tags) and their shared requirement channel.
 */
const makeAuthMwLayer = (connId: ConnectionId) =>
  makeCapMiddlewareLayers(connId);

/**
 * The handler map under the engine group's `HandlersFrom` shape. The runtime
 * map (`server-handlers.ts → serverHandlers`) keys by PLAIN wire-string
 * literals; the group members key by the BRANDED `JsonRpcMethod&lt;...>` tags. The
 * two are structurally identical (the brand is a phantom), but `toLayer`'s
 * `ExcludeProvides` keys its per-handler proof exclusion on `K extends
 * Rpcs["_tag"]` — a plain-string key never matches the branded member tag, so
 * the per-method `*Auth` proof would leak into the bound Layer's requirement
 * channel as an unsatisfiable static dependency. A plain type annotation
 * (NOT a cast) checks the literal is assignable to the branded `HandlersFrom`
 * shape — the brand is structural, so it passes — and gives the binding the
 * branded type so `ExcludeProvides` fires: each handler's own proof drops out
 * (the per-method `*AuthMw` provides it at request time).
 */
const brandedHandlers: RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof WsServerEngineRpcGroup>
> = serverHandlers;

/**
 * Build the full per-socket engine Layer: `RpcServer.layer` (the dispatch
 * loop) provided with the handler-map binding
 * (`WsServerEngineRpcGroup.toLayer(serverHandlers)`), the 26 `*AuthMw`
 * impl Layers, the per-socket `ConnectionTag`, and the `c2s` Protocol. The
 * returned Layer's residual requirement is the application Env the handler
 * bodies + AuthMw caps demand (every service tag) plus `ConnectionManagerTag`
 * — provided by the surrounding application runtime.
 */
export const makeSocketEngineLayer = (options: {
  readonly connId: ConnectionId;
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
  readonly sinkReady: Deferred.Deferred<ChannelSink>;
}) =>
  ServerEngineLayer.pipe(
    Layer.provide(WsServerEngineRpcGroup.toLayer(brandedHandlers)),
    Layer.provide(makeAuthMwLayer(options.connId)),
    Layer.provide(makeConnectionTagLayer(options.connId)),
    Layer.provide(
      makeServerProtocolLayer({
        write: options.write,
        disconnects: options.disconnects,
        sinkReady: options.sinkReady,
      }),
    ),
  );
