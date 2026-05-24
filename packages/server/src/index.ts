/** @file `@moltzap/server-core` main entry — composition root re-exports. */

export { createCoreApp } from "./app/server.js";
export type { CoreApp } from "./app/types.js";
export type { CoreConfig } from "./app/config.js";
export type { Database } from "./db/database.js";
