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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(
  __dirname,
  "..",
  "..",
  "..",
  "server",
  "dist",
  "index.js",
);

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

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to get port from server address"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function pollHealth(port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Server health check timed out after ${timeoutMs}ms on port ${port}`,
  );
}

export async function spawnTestServer(
  pgHost: string,
  pgPort: number,
): Promise<SpawnedServer> {
  // 1. Check server binary exists
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Server not built. Run: pnpm --filter @moltzap/server build\n` +
        `Expected: ${SERVER_ENTRY}`,
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
    max: 2,
  });
  await adminPool.query(
    `CREATE DATABASE "${dbName}" TEMPLATE moltzap_template`,
  );

  // 3. Pre-allocate a free port
  const port = await findFreePort();

  // 4. Spawn server subprocess
  const masterSecret = randomBytes(32).toString("base64");
  const child = spawn("node", [SERVER_ENTRY], {
    env: {
      PATH: process.env.PATH,
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

  // Capture stderr for diagnostics on failure
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Handle unexpected exit
  const exitPromise = new Promise<never>((_, reject) => {
    child.on("exit", (code) => {
      reject(
        new Error(
          `Server exited unexpectedly with code ${code}.\nstderr: ${stderr}`,
        ),
      );
    });
  });

  // 5. Wait for server to be ready
  try {
    await Promise.race([pollHealth(port), exitPromise]);
  } catch (err) {
    child.kill("SIGKILL");
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
    throw err;
  }

  return {
    baseUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}/ws`,
    dbName,
    port,
    process: child,
    adminPool,
  };
}

export async function stopSpawnedServer(server: SpawnedServer): Promise<void> {
  // Kill the server process
  if (server.process.exitCode === null) {
    server.process.kill("SIGTERM");

    // Wait up to 5s for graceful shutdown, then force kill
    await Promise.race([
      new Promise<void>((resolve) =>
        server.process.on("exit", () => resolve()),
      ),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          if (server.process.exitCode === null) {
            server.process.kill("SIGKILL");
          }
          resolve();
        }, 5000),
      ),
    ]);
  }

  // Drop temp database
  try {
    await server.adminPool.query(`DROP DATABASE IF EXISTS "${server.dbName}"`);
  } catch {
    // Best effort — container may already be stopping
  }
  await server.adminPool.end();
}
