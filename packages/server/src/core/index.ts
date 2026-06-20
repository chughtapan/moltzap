/** @file Narrow core wiring barrel for server-core internals. */

export { createCoreApp, ServerBootFailedError } from "./app.js";
export { ConnectionHooksTag } from "./hooks.js";
export { ServicesLive, resolveServices } from "./layers.js";
export type { ResolvedServices } from "./layers.js";

export type { CoreApp, DisconnectionHook } from "./types.js";
