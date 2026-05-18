/**
 * @file Barrel re-exports for the `Connection&lt;Ctx>` public surface.
 *
 * STUB FILE — architect tier, Spec A (#595), arch sub-issue #603.
 *
 * Re-exported from `packages/protocol/src/transport/index.ts` so
 * downstream consumers reach the full Connection surface via
 * `@moltzap/protocol`.
 */

// ── Facade ───────────────────────────────────────────────────────────
export type {
  Connection,
  ConnectionConfig,
  ServerConnection,
  ClientConnection,
} from "./connection.js";
export { makeServerConnection, makeClientConnection } from "./connection.js";

// ── Transport seam ──────────────────────────────────────────────────
export type { SocketLike } from "./socket-like.js";

// ── Handler-registration shapes + JSON boundary type ────────────────
export type {
  ConnectionContext,
  DecodedRequest,
  HookFailure,
  JsonValue,
  RpcHandler,
  Subscription,
} from "./handler.js";

// F3 named-union aliases (`ConnectionCallError` /
// `ConnectionWriteError` / `ConnectionRegisterError`) live in
// `../errors.js` and are re-exported via the transport barrel
// (`../index.js`). The Connection sub-package barrel doesn't re-route
// them — consumers either import the constituent tagged classes here
// or reach the aliases through the transport package barrel.

// ── Backpressure utility (sibling, not part of Connection) ──────────
export {
  queuedHandler,
  rejectWithBusy,
  dropOnFull,
  QueueFullError,
} from "./queued-handler.js";
export type { OnFullPolicy, QueuedHandlerOptions } from "./queued-handler.js";
