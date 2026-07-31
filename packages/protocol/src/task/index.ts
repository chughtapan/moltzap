/**
 * @file Public barrel for the opaque task label and the app send-hook failure.
 */
export { type TaskId, taskId } from "./ids.js";

/** Re-exports the public API from `./hooks.js`. */
export { HookBlockedError } from "./hooks.js";

/** Re-exports the public API from `#identity/apps`. */
export { type AppId, appId, DEFAULT_APP_ID } from "#identity/apps";
