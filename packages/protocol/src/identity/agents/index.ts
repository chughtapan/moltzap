/**
 * @file Agent identity descriptors, schemas, and credentials.
 */
export { type AgentId, agentId } from "./ids.js";
/** Re-exports the public API from `./credentials.js`. */
export { type AgentKey, agentKey } from "./credentials.js";
/** Re-exports the public API from `./registration.js`. */
export { register } from "./registration.js";
/** Re-exports the public API from `./types.js`. */
export { AgentNotFoundError } from "./types.js";
/** Re-exports the public API from `./agents.js`. */
export { agentsList } from "./agents.js";
/** Re-exports the public API from `./types.js`. */
export type { AgentCard } from "./types.js";
