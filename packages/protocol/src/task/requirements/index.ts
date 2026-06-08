/**
 * @file Public barrel for task requirement middleware tags.
 *
 * Each tag is both the descriptor requirement and the `@effect/rpc` middleware
 * tag the server implements. The `obtain*` impls that resolve a permission
 * against server-side services live in `@moltzap/server-core`.
 */

export { TaskReadAccess } from "./task-read-access.js";
export type { TaskReadAccessValue } from "./task-read-access.js";
export {
  assertAppOwnsTask,
  assertTaskReadAccessMatchesTask,
} from "./assert-requirement-matches-task.js";
