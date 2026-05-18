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

// JSON-RPC client + server runtime.
//
// DEPRECATED post-Spec A (#595) cutover: `makeJsonRpcClient`,
// `makeJsonRpcServer`, `handler`, and the `JsonRpcClient` /
// `JsonRpcServer` types delete during impl-staff. New consumers
// must use `Connection<Ctx>` via `makeServerConnection` /
// `makeClientConnection` exported below. See architect sub-issue
// #603 for the migration shape.
export { makeJsonRpcClient } from "./json-rpc-client.js";
export type { JsonRpcClient, RpcCallError } from "./json-rpc-client.js";
export { handler, makeJsonRpcServer } from "./json-rpc-server.js";
export type { JsonRpcServer, RpcHandler } from "./json-rpc-server.js";

// ── Connection facade (Spec A #595) ──────────────────────────────────
//
// Public surface introduced by architect sub-issue #603. Stub bodies
// land here; impl-staff fills implementations and deletes the legacy
// exports above. The Connection sub-package is the single entry point
// for the wire pipeline (JSON.parse → decode → match → dispatch →
// encode → write).
export type {
  Connection,
  ConnectionConfig,
  ConnectionContext,
  DecodedRequest,
  HookFailure,
  OnFullPolicy,
  QueuedHandlerOptions,
  SocketLike,
  Subscription,
} from "./connection/index.js";
// `RpcHandler` is re-exported under the same name as the legacy
// `./json-rpc-server.js` export ABOVE. The legacy export takes
// precedence until impl-staff deletes it; the Connection-native
// `RpcHandler<Ctx, D>` shape ships under a temporary alias here so
// both shapes coexist in the stub branch's barrel without a name
// collision. Impl-staff renames `RpcHandlerV2` → `RpcHandler` after
// deleting the legacy export.
export type { RpcHandler as RpcHandlerV2 } from "./connection/index.js";
export {
  makeServerConnection,
  makeClientConnection,
  queuedHandler,
  rejectWithBusy,
  dropOnFull,
  QueueFullError,
} from "./connection/index.js";

// Connection-facade tagged-error classes. Bodies in `./errors.ts`.
export {
  SocketWriteError,
  SocketReadError,
  ConnectionClosedError,
  RequestTimeoutError,
  JsonRpcErrorResponse,
  DecodeFailure,
  CorrelatorFailure,
  DispatchPanic,
  DuplicateHandlerError,
} from "./errors.js";
// `RpcCallError` from this module is the Connection-native union
// (Spec A "Goals" §3). Aliased to avoid a name collision with the
// legacy `RpcCallError` re-exported from `./json-rpc-client.js`
// above; impl-staff renames `RpcCallErrorV2` → `RpcCallError` after
// deleting the legacy union.
export type {
  ConnectionRunError,
  RemoteTaggedError,
  RpcCallError as RpcCallErrorV2,
} from "./errors.js";
