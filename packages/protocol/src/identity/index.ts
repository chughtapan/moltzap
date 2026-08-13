/**
 * @file Public barrel for identity and agent protocol descriptors.
 */
// safer-arch-ignore no-large-public-surface: This compatibility facade intentionally curates the established identity API while the narrower agents entrypoint remains available.

import {
  type AgentId,
  agentId,
  type AgentKey,
  agentKey,
  register,
  agentsList,
  AgentNotFoundError,
} from "./agents/index.js";

/** Re-exports the public API from `current module`. */
export {
  type AgentId,
  agentId,
  type AgentKey,
  agentKey,
  register,
  agentsList,
  AgentNotFoundError,
};
/** Re-exports the public API from `./agents/index.js`. */
export type { AgentCard } from "./agents/index.js";

/** Re-exports the public API from `./users/index.js`. */
export { type UserId, userId } from "./users/index.js";

/** Re-exports the public API from `./principals/index.js`. */
export { AuthenticatedAgent } from "./principals/index.js";
/** Re-exports the public API from `./principals/index.js`. */
export type { PrincipalRequirement } from "./principals/index.js";
/** Re-exports the public API from `./requirements/index.js`. */
export { ActiveAgent } from "./requirements/index.js";
