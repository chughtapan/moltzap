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
export { ResponseFrameSchema, NotificationFrameSchema } from "./wire.js";

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
export { makeJsonRpcClient } from "./json-rpc-client.js";
export type { JsonRpcClient, RpcCallError } from "./json-rpc-client.js";
export { handler, makeJsonRpcServer } from "./json-rpc-server.js";
export type { JsonRpcServer, RpcHandler } from "./json-rpc-server.js";
