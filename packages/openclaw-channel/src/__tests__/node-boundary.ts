import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dirnameValue = dirname(fileURLToPath(import.meta.url));

// Auto-start entry. `dist/index.js` is the library export surface and exits
// immediately when invoked as a script; `dist/standalone.js` registers the
// auto-start guard that calls startServer().
/** Provides the server entry runtime value. */
export const SERVER_ENTRY = join(
  dirnameValue,
  "..",
  "..",
  "..",
  "server",
  "dist",
  "standalone.js",
);

/** Represents admin pool values. */
export type AdminPool = pg.Pool;

/**
 * Executes the server entry exists operation.
 * @returns The server entry exists result.
 */
export function serverEntryExists(): boolean {
  return existsSync(SERVER_ENTRY);
}

/**
 * Creates admin pool.
 * @param opts Value supplied to the operation.
 * @returns The created admin pool.
 */
export function createAdminPool(opts: pg.PoolConfig): AdminPool {
  return new pg.Pool(opts);
}

/**
 * Runs admin query.
 * @param pool Value supplied to the operation.
 * @param sql Value supplied to the operation.
 * @returns The run admin query result.
 */
export function runAdminQuery(pool: AdminPool, sql: string) {
  return pool.query(sql);
}

/**
 * Executes the close admin pool operation.
 * @param pool Value supplied to the operation.
 * @returns The close admin pool result.
 */
export function closeAdminPool(pool: AdminPool) {
  return pool.end();
}

/**
 * Executes the health request operation.
 * @param port Value supplied to the operation.
 * @param signal Value supplied to the operation.
 * @returns The health request result.
 */
export function healthRequest(port: number, signal: AbortSignal) {
  return fetch(`http://localhost:${port}/health`, { signal });
}

/**
 * Executes the post json request operation.
 * @param url Value supplied to the operation.
 * @param body Serialized response body to decode.
 * @param signal Value supplied to the operation.
 * @returns The post json request result.
 */
export function postJsonRequest(
  url: string,
  body: unknown,
  signal: AbortSignal,
) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
