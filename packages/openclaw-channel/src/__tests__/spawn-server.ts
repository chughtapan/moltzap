/**
 * Spawns the MoltZap server as a subprocess for integration testing.
 * Replaces the in-process startTestServer() with no import dependency on `@moltzap/server`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { Effect } from "effect";
import {
  closeAdminPool as closeAdminPoolBoundary,
  createAdminPool,
  healthRequest,
  runAdminQuery as runAdminQueryBoundary,
  SERVER_ENTRY,
  serverEntryExists,
  type AdminPool,
} from "./node-boundary.js";

const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 100;
const ADMIN_POOL_MAX_CONNECTIONS = 2;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;

class SpawnedServerError extends Error {
  override readonly name = "SpawnedServerError";

  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** Describes spawned server. */
export interface SpawnedServer {
  baseUrl: string;
  wsUrl: string;
  dbName: string;
  port: number;
  process: ChildProcess;
  adminPool: AdminPool;
}

interface ServerLogs {
  readonly stdout: string;
  readonly stderr: string;
}

interface TestDatabase {
  readonly dbName: string;
  readonly adminPool: AdminPool;
}

interface ServerProcess {
  readonly child: ChildProcess;
  readonly readLogs: () => ServerLogs;
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
      server.close(() => {
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function pollHealth(
  port: number,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
): Effect.Effect<void, SpawnedServerError> {
  return Effect.gen(function* () {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const healthy = yield* Effect.tryPromise({
        try: (signal) => healthRequest(port, signal),
        catch: (cause) =>
          new SpawnedServerError("Server health check request failed", cause),
      }).pipe(
        Effect.map((res) => res.ok),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      if (healthy) {
        return;
      }
      yield* Effect.sleep(`${HEALTH_POLL_INTERVAL_MS} millis`);
    }
    return yield* Effect.fail(
      new SpawnedServerError(
        `Server health check timed out after ${timeoutMs}ms on port ${port}`,
      ),
    );
  }).pipe(Effect.withSpan("pollHealth"));
}

function quoteDatabaseName(dbName: string): string {
  return `"${dbName}"`;
}

function runAdminQuery(pool: AdminPool, sql: string) {
  return Effect.tryPromise({
    try: () => runAdminQueryBoundary(pool, sql),
    catch: (cause) =>
      new SpawnedServerError("Admin database query failed", cause),
  });
}

function createDatabaseFromTemplate(pool: AdminPool, dbName: string) {
  return runAdminQuery(
    pool,
    `CREATE DATABASE ${quoteDatabaseName(dbName)} TEMPLATE moltzap_template`,
  );
}

function dropDatabase(pool: AdminPool, dbName: string) {
  return runAdminQuery(
    pool,
    `DROP DATABASE IF EXISTS ${quoteDatabaseName(dbName)}`,
  );
}

function closeAdminPool(pool: AdminPool) {
  return Effect.tryPromise({
    try: () => closeAdminPoolBoundary(pool),
    catch: (cause) =>
      new SpawnedServerError("Admin database pool close failed", cause),
  });
}

function waitForProcessExitOrKill(process: ChildProcess, timeoutMs: number) {
  return new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => {
      if (process.exitCode === null) {
        process.kill("SIGKILL");
      }
      clearTimeout(timer);
      resolve(undefined);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      process.off("exit", onExit);
      resolve(undefined);
    };
    process.once("exit", onExit);
  });
}

function unexpectedExitPromise(
  child: ChildProcess,
  readLogs: () => { readonly stdout: string; readonly stderr: string },
) {
  return new Promise<never>((...args) => {
    const reject = args[1];
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
  return Effect.raceFirst(
    pollHealth(port),
    Effect.tryPromise({
      try: () => unexpectedExitPromise(child, readLogs),
      catch: (cause) =>
        asSpawnedServerError(cause, "Server failed before becoming healthy"),
    }),
  );
}

function cleanupSpawnFailure(
  child: ChildProcess,
  adminPool: AdminPool,
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

function assertServerEntryExists() {
  return serverEntryExists()
    ? Effect.void
    : Effect.fail(
        new SpawnedServerError(
          `Server not built. Run: pnpm --filter @moltzap/server build\n` +
            `Expected: ${SERVER_ENTRY}`,
        ),
      );
}

function createTestDatabase(
  pgHost: string,
  pgPort: number,
): Effect.Effect<TestDatabase, SpawnedServerError> {
  return Effect.gen(function* () {
    const dbName = `test_${crypto.randomUUID().replace(/-/g, "")}`;
    const adminPool = createAdminPool({
      host: pgHost,
      port: pgPort,
      user: "test",
      password: "test",
      database: "postgres",
      max: ADMIN_POOL_MAX_CONNECTIONS,
    });
    yield* createDatabaseFromTemplate(adminPool, dbName);
    return { dbName, adminPool };
  });
}

function findAvailableServerPort() {
  return Effect.tryPromise({
    try: () => findFreePort(),
    catch: (cause) =>
      asSpawnedServerError(cause, "Failed to find a free server port"),
  });
}

function buildServerEnv(
  pgHost: string,
  pgPort: number,
  dbName: string,
  port: number,
) {
  return {
    NODE_ENV: "production",
    DATABASE_URL: `postgresql://test:test@${pgHost}:${pgPort}/${dbName}`,
    MOLTZAP_ADMIN_USER_ID: "00000000-0000-4000-8000-000000000001",
    MOLTZAP_DEV_MODE: "true",
    PORT: String(port),
    FIREBASE_SERVICE_ACCOUNT_KEY: generateTestFirebaseKey(),
    VAPID_PUBLIC_KEY:
      "BHKL-uNCIASscCmYZERbVn--qT9RVp6mt90rIrLwrXSAxuCTSbamzi7JlQulOQ5TTmAzMgYLcsqzEM-zFLSFbdE",
    VAPID_PRIVATE_KEY: "Z9kV3uuqbO7rr_39L2dFA-FKgVpeLv6gS6W_5_cylMk",
    VAPID_SUBJECT: "mailto:test@example.com",
  };
}

function captureProcessLogs(child: ChildProcess): () => ServerLogs {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return () => ({ stdout, stderr });
}

function spawnServerProcess(
  pgHost: string,
  pgPort: number,
  dbName: string,
  port: number,
): ServerProcess {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: buildServerEnv(pgHost, pgPort, dbName, port),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, readLogs: captureProcessLogs(child) };
}

function startSpawnedServer(pgHost: string, pgPort: number) {
  return Effect.gen(function* () {
    yield* assertServerEntryExists();
    const { dbName, adminPool } = yield* createTestDatabase(pgHost, pgPort);
    const port = yield* findAvailableServerPort();
    const { child, readLogs } = spawnServerProcess(
      pgHost,
      pgPort,
      dbName,
      port,
    );

    yield* waitForServerReady(child, port, readLogs).pipe(
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
  });
}

/**
 * Executes the spawn test server operation.
 * @param pgHost Value supplied to the operation.
 * @param pgPort Value supplied to the operation.
 * @returns The spawn test server result.
 */
export function spawnTestServer(pgHost: string, pgPort: number) {
  return Effect.runPromise(
    startSpawnedServer(pgHost, pgPort).pipe(Effect.withSpan("spawnTestServer")),
  );
}

/**
 * Executes the stop spawned server operation.
 * @param server Value supplied to the operation.
 * @returns The stop spawned server result.
 */
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
    }).pipe(Effect.withSpan("stopSpawnedServer")),
  );
}
