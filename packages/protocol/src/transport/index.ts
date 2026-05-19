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

// Transport-layer call errors (raised by JsonRpcClient + ws-client).
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
} from "./wire-errors.js";
export type { RpcErrorClass, RpcErrorPayload } from "./wire-errors.js";

// Decoded RPC + notification types. Group-level decode helpers
// (`decodeRpcRequest`, `decodeNotification`, `isDecodedNotification`)
// are protocol-internal — consumers reach the same surface via
// `decodeServerInbound` / `decodeClientInbound` and discriminate on
// `definition` identity.
export type { DecodedRpcRequest, DecodedNotification } from "./rpc-groups.js";

// JSON-RPC originator error surface — outbound RPC error type used by
// every `Connection.call` signature.
export type { RpcCallError } from "./json-rpc-client.js";

/**
 * Spec F (#617) Invariant FRI carryover surface.
 *
 * `makeJsonRpcClient` / `makeJsonRpcServer` / `handler` are the legacy
 * pre-Spec-F factories. The Spec F PR ships the replacement
 * `make{Server,AgentClient,TaskMaster}Connection` factories (below) and
 * relocates the legacy symbols to this `@deprecated` re-export block.
 *
 * Cutover plan: every consumer of these symbols (LSP-verified —
 * `packages/server/src/app/server.ts → createCoreApp`,
 * `packages/server/src/transport/connection.ts → acquireConnectionRpcClient`,
 * `packages/client/src/ws-client.ts`,
 * `packages/protocol/src/testing/conformance/_shared/driver/*.ts`)
 * migrates to the typed factories in incremental follow-up PRs. Once
 * the consumer list reaches zero, this re-export block deletes
 * (per Invariant FRI) and the underlying impl files (`json-rpc-server.ts`,
 * `json-rpc-client.ts`) collapse into `dispatch.ts` private helpers.
 *
 * **DO NOT use these in new code.** New connections go through the
 * typed factories below; they enforce per-kind static catalogs at the
 * type level (Spec F G3) and auto-provision Spec E capabilities via
 * the `CapabilityProviderTable` (Spec F G5/G6).
 * @deprecated Spec F (#617) — use `makeServerConnection`,
 * `makeAgentClientConnection`, or `makeTaskMasterConnection`.
 */
export { makeJsonRpcClient } from "./json-rpc-client.js";
export type { JsonRpcClient } from "./json-rpc-client.js";
/** @deprecated Spec F (#617) — use `makeServerConnection`. */
export { handler, makeJsonRpcServer } from "./json-rpc-server.js";
export type { JsonRpcServer, RpcHandler } from "./json-rpc-server.js";

// Spec F (#617) — typed dispatcher. Stubs only on this branch; impl-staff
// fills bodies. Type-level invariants are exercised by
// `typed-dispatcher.types-check.ts`.
export type {
  CapabilityDescriptor,
  CapabilityProviderTable,
  CapabilitiesOf,
} from "./capabilities.js";
export type {
  FailClosedDefault,
  SlotDisposition,
  IsOptionalSlot,
  FailClosedForbidden,
} from "./defaults.js";
export { optionalForbidden, optionalNoOp } from "./defaults.js";
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
