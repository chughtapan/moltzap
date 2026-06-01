/**
 * @file Per-socket native `@effect/rpc` server engine composition.
 *
 * Stands one `RpcServer<WsServerEngineRpcGroup>` per WebSocket inside the
 * connection's `Scope`. The engine needs three per-socket layers, each
 * closing over THIS socket's `connId`:
 *
 * - `makeServerProtocolLayer({ write, disconnects })` — the `c2s` Protocol
 *   binding the mux channel to the engine's inbound/outbound frame path.
 * - the 26 `make*AuthMwLayer(connId)` impl Layers — one per authenticated WS
 *   method, each peeking the live arm and running the method's principal gate
 *   + caps (`auth-middleware-layers.ts`). Merged via `Layer.mergeAll`.
 * - `makeConnectionTagLayer(connId)` — the request-scoped full-arm read the
 *   native handler bodies (`native-handlers-runtime.ts → agentArm/appArm`)
 *   type against, resolved per access off `ConnectionManagerTag`.
 *
 * These are NEVER app-memoized: each closes over `connId`, so two concurrent
 * sockets stand two disjoint engines with disjoint auth/connection arms. The
 * `MUX_CLIENT_ID = 0` the mux reports per socket load-bears nothing — the
 * closed-over `connId` is the only connection key. The 2-concurrent-socket
 * cross-principal isolation test is the regression proof.
 */
import { RpcGroup } from "@effect/rpc";
import { Effect, Layer, type Mailbox } from "effect";
import {
  ServerEngineLayer,
  WsServerEngineRpcGroup,
  makeServerProtocolLayer,
  type WireWrite,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import { ConnectionManagerTag, ConnectionTag } from "../app/layers.js";
import { serverNativeHandlers } from "../app/native-handlers.js";
import { peekLiveArm } from "./principal-gate.js";
import {
  makeMessagesSendAuthMwLayer,
  makeMessagesListAuthMwLayer,
  makeTaskListAuthMwLayer,
  makeTaskRequestAuthMwLayer,
  makeTaskLeaveAuthMwLayer,
  makeTaskConversationListAuthMwLayer,
  makeAgentsLookupAuthMwLayer,
  makeAgentsLookupByNameAuthMwLayer,
  makeAgentsListAuthMwLayer,
  makeContactsListAuthMwLayer,
  makeContactsAddAuthMwLayer,
  makeContactsAcceptAuthMwLayer,
  makeContactsByIdAuthMwLayer,
  makeDispatchRequestAuthMwLayer,
  makeNetworkPingAuthMwLayer,
  makePresenceSubscribeAuthMwLayer,
  makeTaskCloseAuthMwLayer,
  makeTaskAddParticipantAuthMwLayer,
  makeTaskRemoveParticipantAuthMwLayer,
  makeTaskConversationCreateAuthMwLayer,
  makeAppsRegisterAuthMwLayer,
  makeDispatchesGetAuthMwLayer,
  makeTaskConversationArchiveAuthMwLayer,
  makeTaskConversationUnarchiveAuthMwLayer,
  makeTaskConversationAddParticipantAuthMwLayer,
  makeTaskConversationRemoveParticipantAuthMwLayer,
} from "./auth-middleware-layers.js";

/**
 * The request-scoped `ConnectionTag` for ONE socket. `Layer.effect` resolves
 * the layer body once per `RpcServer` build (per socket); the body reads the
 * live arm off `ConnectionManagerTag` keyed by the closed-over `connId`. The
 * arm read is `peekLiveArm`, which returns the FULL live `Connection` (any
 * arm), so a native handler body narrowing on `_tag` after its `*AuthMw` gate
 * sees the arm the gate already promoted.
 *
 * `ConnectionTag` carries the socket-fixed `connId` and resolves the arm at
 * build time. The per-request principal fields a handler narrows on
 * (`agentId`/`ownerUserId`) ride the `*AuthMw` proof, not this tag; this tag is
 * the full-arm read for the handler-body context the proof's `PrincipalForKind`
 * projection omits.
 */
export const makeConnectionTagLayer = (
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
 * over `connId` and requires `ConnectionManagerTag` (the cap-bearing ones also
 * require `MwEnv`); `Layer.mergeAll` unions their outputs (the 26 distinct
 * middleware Tags) and their shared requirement channel.
 */
const makeAuthMwLayer = (connId: ConnectionId) =>
  Layer.mergeAll(
    makeMessagesSendAuthMwLayer(connId),
    makeMessagesListAuthMwLayer(connId),
    makeTaskListAuthMwLayer(connId),
    makeTaskRequestAuthMwLayer(connId),
    makeTaskLeaveAuthMwLayer(connId),
    makeTaskConversationListAuthMwLayer(connId),
    makeAgentsLookupAuthMwLayer(connId),
    makeAgentsLookupByNameAuthMwLayer(connId),
    makeAgentsListAuthMwLayer(connId),
    makeContactsListAuthMwLayer(connId),
    makeContactsAddAuthMwLayer(connId),
    makeContactsAcceptAuthMwLayer(connId),
    makeContactsByIdAuthMwLayer(connId),
    makeDispatchRequestAuthMwLayer(connId),
    makeNetworkPingAuthMwLayer(connId),
    makePresenceSubscribeAuthMwLayer(connId),
    makeTaskCloseAuthMwLayer(connId),
    makeTaskAddParticipantAuthMwLayer(connId),
    makeTaskRemoveParticipantAuthMwLayer(connId),
    makeTaskConversationCreateAuthMwLayer(connId),
    makeAppsRegisterAuthMwLayer(connId),
    makeDispatchesGetAuthMwLayer(connId),
    makeTaskConversationArchiveAuthMwLayer(connId),
    makeTaskConversationUnarchiveAuthMwLayer(connId),
    makeTaskConversationAddParticipantAuthMwLayer(connId),
    makeTaskConversationRemoveParticipantAuthMwLayer(connId),
  );

/**
 * Build the full per-socket engine Layer: `RpcServer.layer` (the dispatch
 * loop) provided with the handler-map binding
 * (`WsServerEngineRpcGroup.toLayer(serverNativeHandlers)`), the 26 `*AuthMw`
 * impl Layers, the per-socket `ConnectionTag`, and the `c2s` Protocol. The
 * returned Layer's residual requirement is the application Env the handler
 * bodies + AuthMw caps demand (every service tag) plus `ConnectionManagerTag`
 * — provided by the surrounding application runtime.
 */
/**
 * The handler map under the engine group's `HandlersFrom` shape. The runtime
 * map (`native-handlers.ts → serverNativeHandlers`) keys by PLAIN wire-string
 * literals; the group members key by the BRANDED `JsonRpcMethod<...>` tags. The
 * two are structurally identical (the brand is a phantom), but `toLayer`'s
 * `ExcludeProvides` keys its per-handler proof exclusion on `K extends
 * Rpcs["_tag"]` — a plain-string key never matches the branded member tag, so
 * the per-method `*Auth` proof would leak into the bound Layer's requirement
 * channel as an unsatisfiable static dependency. Relabelling the keys to the
 * branded `HandlersFrom` shape lets `ExcludeProvides` fire: each handler's own
 * proof drops out (the per-method `*AuthMw` provides it at request time).
 */
const brandedHandlers = serverNativeHandlers as unknown as RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof WsServerEngineRpcGroup>
>;

export const makeSocketEngineLayer = (options: {
  readonly connId: ConnectionId;
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
}) =>
  ServerEngineLayer.pipe(
    Layer.provide(WsServerEngineRpcGroup.toLayer(brandedHandlers)),
    Layer.provide(makeAuthMwLayer(options.connId)),
    Layer.provide(makeConnectionTagLayer(options.connId)),
    Layer.provide(
      makeServerProtocolLayer({
        write: options.write,
        disconnects: options.disconnects,
      }),
    ),
  );
