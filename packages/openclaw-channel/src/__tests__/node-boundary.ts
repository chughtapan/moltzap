import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-start entry. `dist/index.js` is the library export surface and exits
// immediately when invoked as a script; `dist/standalone.js` registers the
// auto-start guard that calls startServer().
export const SERVER_ENTRY = join(
  __dirname,
  "..",
  "..",
  "..",
  "server",
  "dist",
  "standalone.js",
);

export type AdminPool = pg.Pool;

export function serverEntryExists(): boolean {
  return existsSync(SERVER_ENTRY);
}

export function createAdminPool(opts: pg.PoolConfig): AdminPool {
  return new pg.Pool(opts);
}

export function runAdminQuery(pool: AdminPool, sql: string) {
  return pool.query(sql);
}

export function closeAdminPool(pool: AdminPool) {
  return pool.end();
}

export function healthRequest(port: number, signal: AbortSignal) {
  return fetch(`http://localhost:${port}/health`, { signal });
}

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
