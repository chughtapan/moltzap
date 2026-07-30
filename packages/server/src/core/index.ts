/** @file Narrow core wiring barrel for server-core internals. */

/** Re-exports the public API from `./app.js`. */
export { createCoreApp, ServerBootFailedError } from "./app.js";
/** Re-exports the public API from `./layers.js`. */
export { servicesLive, resolveServices } from "./layers.js";
/** Re-exports the public API from `./layers.js`. */
export type { ResolvedServices } from "./layers.js";

/** Re-exports the public API from `./types.js`. */
export type { CoreApp, DisconnectionHook } from "./types.js";
