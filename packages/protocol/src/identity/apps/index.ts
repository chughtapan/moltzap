/**
 * @file App identity descriptors, identifiers, and credentials.
 */
export { type AppId, appId, DEFAULT_APP_ID } from "./ids.js";
/** Re-exports the public API from `./credentials.js`. */
export { type AppKey, appKey } from "./credentials.js";
/** Re-exports the public API from `./manifest.js`. */
export { validateAppManifest } from "./manifest.js";
/** Re-exports the public API from `./manifest.js`. */
export type { AppManifest, AppManifestValidationResult } from "./manifest.js";
