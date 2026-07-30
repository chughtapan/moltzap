/**
 * @file Public barrel for task requirement middleware tags.
 *
 * Each tag is both the descriptor requirement and the `@effect/rpc` middleware
 * tag the server implements. The `obtain*` impls that resolve a permission
 * against server-side services live in `@moltzap/server-core`.
 */

/** Re-exports the public API from `./task-read-access.js`. */
export { TaskReadAccess } from "./task-read-access.js";
/** Re-exports the public API from `./task-read-access.js`. */
export type { TaskReadAccessValue } from "./task-read-access.js";
/** Re-exports the public API from `./assert-requirement-matches-task.js`. */
export {
  assertAppOwnsTask,
  assertTaskReadAccessMatchesTask,
} from "./assert-requirement-matches-task.js";
