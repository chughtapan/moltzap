/**
 * Spawns the MoltZap server as a subprocess for integration testing.
 * Replaces the in-process startTestServer() — no import dependency on @moltzap/server.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Config, ConfigProvider, Effect, Option } from "effect";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Auto-start entry. `dist/index.js` is the library export surface and exits
// immediately when invoked as a script; `dist/standalone.js` registers the
// auto-start guard that calls startServer().
const SERVER_ENTRY = join(
  __dirname,
  "..",
  "..",
  "..",
  "server",
  "dist",
  "standalone.js",
);
const SpawnPath = Config.option(Config.string("PATH"));
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 100;
const ADMIN_POOL_MAX_CONNECTIONS = 2;
const MASTER_SECRET_BYTES = 32;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;

class SpawnedServerError extends Error {
  override readonly name = "SpawnedServerError";

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface SpawnedServer {
  baseUrl: string;
  wsUrl: string;
  dbName: string;
  port: number;
  process: ChildProcess;
  adminPool: pg.Pool;
}

function generateTestFirebaseKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return JSON.stringify({
    type: "service_account",
    project_id: "test",
    private_key_id: "key1",
    private_key: privateKey,
    client_email: "test@test.iam.gserviceaccount.com",
    client_id: "123",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

function readSpawnPath(): string | undefined {
  return Option.getOrUndefined(
    Effect.runSync(
      SpawnPath.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
    ),
  );
}

function asSpawnedServerError(cause: unknown, fallbackMessage: string) {
  return cause instanceof SpawnedServerError
    ? cause
    : new SpawnedServerError(fallbackMessage, cause);
}

function findFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(
          new SpawnedServerError("Failed to get port from server address"),
        );
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function pollHealth(port: number, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const healthy = yield* Effect.tryPromise({
          try: (signal) => fetch(`http://localhost:${port}/health`, { signal }),
          catch: (cause) =>
            new SpawnedServerError("Server health check request failed", cause),
        }).pipe(
          Effect.map((res) => res.ok),
          Effect.catchAll(() => Effect.succeed(false)),
        );
        if (healthy) return;
        yield* Effect.sleep(`${HEALTH_POLL_INTERVAL_MS} millis`);
      }
      return yield* Effect.fail(
        new SpawnedServerError(
          `Server health check timed out after ${timeoutMs}ms on port ${port}`,
        ),
      );
    }),
  );
}

function adminQuery(pool: pg.Pool, sql: string) {
  return pool.query(sql);
}

function quoteDatabaseName(dbName: string): string {
  return `"${dbName}"`;
}

function runAdminQuery(pool: pg.Pool, sql: string) {
  return Effect.tryPromise({
    try: () => adminQuery(pool, sql),
    catch: (cause) =>
      new SpawnedServerError("Admin database query failed", cause),
  });
}

function createDatabaseFromTemplate(pool: pg.Pool, dbName: string) {
  return runAdminQuery(
    pool,
    `CREATE DATABASE ${quoteDatabaseName(dbName)} TEMPLATE moltzap_template`,
  );
}

function dropDatabase(pool: pg.Pool, dbName: string) {
  return runAdminQuery(
    pool,
    `DROP DATABASE IF EXISTS ${quoteDatabaseName(dbName)}`,
  );
}

function closeAdminPool(pool: pg.Pool) {
  return Effect.tryPromise({
    try: () => pool.end(),
    catch: (cause) =>
      new SpawnedServerError("Admin database pool close failed", cause),
  });
}

function waitForProcessExitOrKill(process: ChildProcess, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      process.off("exit", onExit);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      if (process.exitCode === null) {
        process.kill("SIGKILL");
      }
      cleanup();
      resolve();
    }, timeoutMs);
    process.once("exit", onExit);
  });
}

function unexpectedExitPromise(
  child: ChildProcess,
  readLogs: () => { readonly stdout: string; readonly stderr: string },
) {
  return new Promise<never>((_, reject) => {
    child.on("exit", (code) => {
      const logs = readLogs();
      reject(
        new SpawnedServerError(
          `Server exited unexpectedly with code ${code}.\nstdout: ${logs.stdout}\nstderr: ${logs.stderr}`,
        ),
      );
    });
  });
}

function waitForServerReady(
  child: ChildProcess,
  port: number,
  readLogs: () => {
    readonly stdout: string;
    readonly stderr: string;
  },
) {
  return Effect.tryPromise({
    try: () =>
      Promise.race([pollHealth(port), unexpectedExitPromise(child, readLogs)]),
    catch: (cause) =>
      asSpawnedServerError(cause, "Server failed before becoming healthy"),
  });
}

function cleanupSpawnFailure(
  child: ChildProcess,
  adminPool: pg.Pool,
  dbName: string,
) {
  return Effect.gen(function* () {
    child.kill("SIGKILL");
    yield* dropDatabase(adminPool, dbName).pipe(
      Effect.catchAll(() => Effect.void),
    );
    yield* closeAdminPool(adminPool).pipe(Effect.catchAll(() => Effect.void));
  });
}

export function spawnTestServer(pgHost: string, pgPort: number) {
  return Effect.runPromise(
    Effect.gen(function* () {
      // 1. Check server binary exists
      if (!existsSync(SERVER_ENTRY)) {
        return yield* Effect.fail(
          new SpawnedServerError(
            `Server not built. Run: pnpm --filter @moltzap/server build\n` +
              `Expected: ${SERVER_ENTRY}`,
          ),
        );
      }

      // 2. Create temp database from template
      const dbName = `test_${crypto.randomUUID().replace(/-/g, "")}`;
      const adminPool = new pg.Pool({
        host: pgHost,
        port: pgPort,
        user: "test",
        password: "test",
        database: "postgres",
        max: ADMIN_POOL_MAX_CONNECTIONS,
      });
      yield* createDatabaseFromTemplate(adminPool, dbName);

      // 3. Pre-allocate a free port
      const port = yield* Effect.tryPromise({
        try: () => findFreePort(),
        catch: (cause) =>
          asSpawnedServerError(cause, "Failed to find a free server port"),
      });

      // 4. Spawn server subprocess
      const masterSecret = randomBytes(MASTER_SECRET_BYTES).toString("base64");
      const child = spawn("node", [SERVER_ENTRY], {
        env: {
          PATH: readSpawnPath(),
          NODE_ENV: "production",
          DATABASE_URL: `postgresql://test:test@${pgHost}:${pgPort}/${dbName}`,
          ENCRYPTION_MASTER_SECRET: masterSecret,
          MOLTZAP_DEV_MODE: "true",
          PORT: String(port),
          FIREBASE_SERVICE_ACCOUNT_KEY: generateTestFirebaseKey(),
          VAPID_PUBLIC_KEY:
            "BHKL-uNCIASscCmYZERbVn--qT9RVp6mt90rIrLwrXSAxuCTSbamzi7JlQulOQ5TTmAzMgYLcsqzEM-zFLSFbdE",
          VAPID_PRIVATE_KEY: "Z9kV3uuqbO7rr_39L2dFA-FKgVpeLv6gS6W_5_cylMk",
          VAPID_SUBJECT: "mailto:test@example.com",
          CLAIM_BASE_URL: `http://localhost:${port}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Capture stdout + stderr for diagnostics on failure. The server uses
      // pino, which writes to stdout — surface both streams so failure messages
      // aren't swallowed.
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // 5. Wait for server to be ready
      yield* waitForServerReady(child, port, () => ({ stdout, stderr })).pipe(
        Effect.catchAll((err) =>
          cleanupSpawnFailure(child, adminPool, dbName).pipe(
            Effect.zipRight(Effect.fail(err)),
          ),
        ),
      );

      return {
        baseUrl: `http://localhost:${port}`,
        wsUrl: `ws://localhost:${port}/ws`,
        dbName,
        port,
        process: child,
        adminPool,
      };
    }),
  );
}

export function stopSpawnedServer(server: SpawnedServer) {
  return Effect.runPromise(
    Effect.gen(function* () {
      // Kill the server process
      if (server.process.exitCode === null) {
        server.process.kill("SIGTERM");
        yield* Effect.tryPromise({
          try: () =>
            waitForProcessExitOrKill(
              server.process,
              GRACEFUL_SHUTDOWN_TIMEOUT_MS,
            ),
          catch: (cause) =>
            new SpawnedServerError("Server process shutdown failed", cause),
        });
      }

      // Drop temp database
      yield* dropDatabase(server.adminPool, server.dbName).pipe(
        Effect.catchAll(() => Effect.void),
      );
      yield* closeAdminPool(server.adminPool);
    }),
  );
}
