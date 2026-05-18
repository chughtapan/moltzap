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
export type { Connection, ConnectionConfig } from "./connection.js";
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

// ── Backpressure utility (sibling, not part of Connection) ──────────
export {
  queuedHandler,
  rejectWithBusy,
  dropOnFull,
  QueueFullError,
} from "./queued-handler.js";
export type { OnFullPolicy, QueuedHandlerOptions } from "./queued-handler.js";
