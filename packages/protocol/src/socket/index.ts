/** @file Public socket client and server compatibility surface. */

/** Re-exports the public API from `./lifecycle.js`. */
export { MoltZapAgentClient } from "./lifecycle.js";

/** Re-exports the public API from `./server.js`. */
export { connectionId, connectionIdSchema, MoltZapServer } from "./server.js";
/** Re-exports the public API from `./server.js`. */
export type {
  ConnectionId,
  MoltZapServerSession,
  ReverseClient,
} from "./server.js";
