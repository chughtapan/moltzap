/**
 * @file Public barrel for JSON-RPC transport descriptors and runtime helpers.
 */
// Wire (frame types only — request/response/notification frame builders
// are per-def `encode*` methods on RpcDefinition / NotificationDefinition.
// `encodeErrorResponse` is the single method-agnostic wire encoder.)
export { encodeErrorResponse } from "./wire.js";
export type {
  JsonRpcId,
  RequestFrame,
  ResponseFrame,
  NotificationFrame,
} from "./wire.js";

// Wire frame schemas (TypeBox) — exported so testing/conformance can
// validate frames against the canonical shape via @moltzap/protocol/transport
// rather than reaching into wire.js by relative path.
export {
  responseFrameSchema,
  responseFrameSchema as ResponseFrameSchema,
  notificationFrameSchema,
  notificationFrameSchema as NotificationFrameSchema,
} from "./wire.js";

// RPC + notification descriptor types. Decoders are protocol-internal;
// consumers go through `decodeServerInbound` / `decodeClientInbound`
// (rpc-registry.ts) or per-def `validateParams`.
export type {
  RpcDefinition,
  NotificationDefinition,
  ParamsOf,
  ResultOf,
  NotificationParamsOf,
} from "./method.js";

// Transport-layer call errors (raised by Originator + ws-client).
export {
  NotConnectedError,
  RpcTimeoutError,
  RpcServerError,
} from "./rpc-errors.js";

// Wire-coded tagged errors. `registerErrorClass` is intentionally NOT
// re-exported here: the registered-class set is closed (mirrored by the
// `RegisteredTaggedError` union in `rpc-registry.ts`); protocol-internal
// classes self-register via relative imports of `./wire-errors.js`.
export {
  JSON_RPC_RESERVED_CODES,
  MalformedFrameError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidParamsError,
  // Read-only registry predicate — lets a consumer (e.g. the CLI transport)
  // recognise any registered wire-error instance and recover its static
  // `code`/`message`. Does NOT expose `registerErrorClass`: the registered set
  // stays closed.
  isRegisteredErrorInstance,
} from "./wire-errors.js";
export type { RpcErrorClass, RpcErrorPayload } from "./wire-errors.js";

// Decoded RPC + notification types. Group-level decode helpers
// (`decodeRpcRequest`, `decodeNotification`) remain protocol-internal —
// consumers reach the same surface via `decodeServerInbound` /
// `decodeClientInbound` and discriminate on `definition` identity.
// `isDecodedNotification` is the typed-guard companion that Spec B
// (#596) Stream-based `client.notifications`/`subscribeTo` callers use to
// narrow filtered frames to `DecodedNotification<D>`; it is part of the
// public surface.
export type { DecodedRpcRequest, DecodedNotification } from "./rpc-groups.js";
export { isDecodedNotification } from "./rpc-groups.js";

// JSON-RPC originator error surface — outbound RPC error type used by
// every `Connection.call` signature.
export type { RpcCallError } from "./originator.js";

// Spec F (#617) — typed dispatcher. Per-kind static handler tables and
// three connection factories (`make{Server,AgentClient,TaskMaster}Connection`).
// Type-level invariants are exercised by `typed-dispatcher.types-check.ts`.
export type {
  CapabilityDescriptor,
  CapabilityProviderTable,
  CapabilitiesOf,
} from "./capabilities.js";
export type {
  HandlerSlot,
  HandlerTable,
  ServerHandlers,
  AgentClientHandlers,
  TaskMasterHandlers,
  ServerInboundRpcDefinition,
  TaskMasterInboundRpcDefinition,
  CapsUnionOf,
} from "./handlers.js";
export type {
  ServerConnection,
  AgentClientConnection,
  TaskMasterConnection,
  ServerConnectionConfig,
  AgentClientConnectionConfig,
  TaskMasterConnectionConfig,
} from "./connection.js";
export {
  makeServerConnection,
  makeAgentClientConnection,
  makeTaskMasterConnection,
} from "./connection.js";
export {
  buildServerDispatcher,
  buildAgentClientDispatcher,
  buildTaskMasterDispatcher,
} from "./dispatch.js";
