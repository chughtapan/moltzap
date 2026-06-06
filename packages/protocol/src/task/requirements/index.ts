/**
 * @file Public barrel for task requirement middleware tags.
 *
 * Each tag is both the descriptor requirement and the `@effect/rpc` middleware
 * tag the server implements. The `obtain*` impls that resolve a permission
 * against server-side services live in `@moltzap/server-core`.
 */

export { TaskReadAccess } from "./task-read-access.js";
export type { TaskReadAccessValue } from "./task-read-access.js";
export { ConversationInTask } from "./conversation-in-task.js";
export type { ConversationInTaskValue } from "./conversation-in-task.js";
export { ConversationSendAccess } from "./conversation-send-access.js";
export type { ConversationSendAccessValue } from "./conversation-send-access.js";
export { ContactPolicyAllowsReach } from "./contact-policy-allows-reach.js";
export type { ContactPolicyAllowsReachValue } from "./contact-policy-allows-reach.js";
export {
  assertAppOwnsTask,
  assertConversationInTaskMatches,
  assertTaskReadAccessMatchesTask,
} from "./assert-requirement-matches-task.js";
