/**
 * @file Public barrel for the engine layer — the descriptor-aggregate machinery
 * that sits ABOVE the domains.
 *
 * Where `transport/` is the wire DAG bottom (frames, the descriptor factory, the
 * mux) and the domains list their `requires` against the low principal tags
 * (`transport/principal.ts`), THIS layer owns everything that genuinely couples
 * to the full catalog + the capability tags: the genuine `Requirement` union +
 * `CapabilityRequirement` + classifiers (`requirements.ts`, referencing the
 * task-layer cap tags); the per-requirement `@effect/rpc` middlewares + the
 * TOTAL `requirementMiddleware` registry (`cap-middlewares.ts`); the server
 * engine group + the WS engine + the client-callable group projections (all
 * consuming the aggregated descriptor catalog); and `CurrentPrincipal` (the request
 * principal as a service, referencing the identity/task brands).
 *
 * Surfaced through the package's main barrel (`@moltzap/protocol`), not a
 * separate subpath: server-core consumes these via the main entry.
 */

// Typed dispatcher slots + the inbound app-callback definition type. These
// consume the aggregated descriptor catalog, so they sit at the engine
// layer (above the domains).
export type {
  HandlerSlot,
  AppCallbackHandlers,
  AppCallbackInboundRpcDefinition,
} from "./handlers.js";

// Reverse server→client RPC groups (the s2c channel). `ReverseRpcGroup` carries
// the moderator callbacks (`dispatch/authorize`, `messages/authorize`,
// `task/create`) ∪ every notification; `NotificationRpcGroup` carries every
// `defineNotification` as a fire-and-forget `void`-result RPC. The server holds
// the `RpcClient`; the client stands the `RpcServer` (the notification handlers
// route into the `SubscriberRegistry`).
export {
  NotificationRpcGroup,
  ReverseRpcGroup,
  serverRpcMethods,
  agentClientRpcMethods,
  appCallableRpcMethods,
  notificationDefinitions,
  appCallbackMethods,
} from "./rpc-method-groups.js";
export type {
  AnyServerRpcDefinition,
  AnyAgentClientRpcDefinition,
  AnyAppCallbackRpcDefinition,
  AnyNotificationDefinition,
} from "./rpc-method-groups.js";

// Principal-as-service: the protocol-owned `CurrentPrincipal` Tag a cap
// middleware reads (`yield* CurrentPrincipal`) when deriving its payload.
export type { Principal } from "./current-principal.js";
export { CurrentPrincipal, callerAgentId } from "./current-principal.js";

// The genuine `Requirement` union + classifiers. `AgentPrincipal`/`AppPrincipal`
// (the principal tags) live in `transport/principal.ts` (the wire layer the
// domains depend on downward); the capability half + the concrete union live
// here, above the domains.
export {
  principalRequirementOf,
  requiresClaimed,
  capRequirementsOf,
} from "./requirements.js";
export type {
  Requirement,
  CapabilityRequirement,
  PrincipalRequirement,
  PrincipalRequirementOf,
} from "./requirements.js";

// Per-requirement `@effect/rpc` middlewares. Each requirement is its own
// `RpcMiddleware.Tag`; the engine stacks one per `requires` entry
// (`server-engine-group.ts → buildEngineMember`). Each cap mw `provides` its
// capability `Context.Tag` and carries its own `failure` (the cap's error
// union), which the engine unions into the method's wire error. The server
// supplies each mw's impl as a per-socket Layer
// (`server-core auth-middleware-layers.ts`).
export {
  PrincipalGateMw,
  ConversationInTaskMw,
  ConversationSendAccessMw,
  TaskReadAccessMw,
  ContactPolicyAllowsReachMw,
  requirementMiddleware,
  type MiddlewareRequirementKey,
  type MwForRequirement,
  type MwStackFor,
} from "./cap-middlewares.js";

// The middleware-attached server engine group + the WS-dispatched subset the
// live engine binds + the unauthenticated-method allowlist that partitions it.
// `ServerEngineRpcGroup` gates every member except `UNAUTHENTICATED_METHODS`
// with that method's own `*AuthMw`; `WsServerEngineRpcGroup` is the same group
// (every catalog method is WS-dispatched), so its members map one-to-one onto
// the server's handler map.
export {
  ServerEngineRpcGroup,
  WsServerEngineRpcGroup,
  UNAUTHENTICATED_METHODS,
  isUnauthenticatedMethod,
} from "./server-engine-group.js";
export type { UnauthenticatedMethod } from "./server-engine-group.js";

// `@effect/rpc` server engine over the mux. `ServerEngineLayer` runs
// `RpcServer` for the WS-dispatched `WsServerEngineRpcGroup`;
// `makeServerProtocolLayer` builds the `RpcServer.Protocol` over a c→s mux
// channel. The live connection composes these with
// `WsServerEngineRpcGroup.toLayer(serverHandlers)`.
export { makeServerProtocolLayer, ServerEngineLayer } from "./server-engine.js";

// The two first-party client-callable group projections of the
// `serverRpcMethods` catalog, partitioned by each descriptor's principal
// requirement (its `requires` head). An agent client types against
// `AgentCallableGroup`, an app client against `AppCallableGroup`, so a
// cross-principal call is a compile error (the runtime gate stays the
// untrusted-peer backstop).
export {
  AgentCallableGroup,
  AppCallableGroup,
} from "./client-callable-groups.js";
