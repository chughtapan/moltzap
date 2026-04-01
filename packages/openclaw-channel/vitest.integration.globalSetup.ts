import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSetupContext } from "vitest/node";
import {
  startEchoServer,
  type EchoServer,
} from "./src/__tests__/echo-server.js";
import { echoModelConfig } from "./src/__tests__/openclaw-container.js";
import {
  isImageAvailable,
  buildOpenClawConfig,
  startRawContainer,
  waitForReady,
  stopContainer,
  type OpenClawContainer,
} from "./src/test-utils/container-core.js";
import { hashPhone } from "@moltzap/protocol/phone-hash";
import {
  spawnTestServer,
  stopSpawnedServer,
  type SpawnedServer,
} from "./src/__tests__/spawn-server.js";

let pgContainer: StartedPostgreSqlContainer | null = null;
let echoServer: EchoServer | null = null;
let containerA: OpenClawContainer | null = null;
let containerB: OpenClawContainer | null = null;
let spawnedServer: SpawnedServer | null = null;

export default async function ({ provide }: GlobalSetupContext) {
  // Phase 1: Postgres + echo server in parallel
  const [pg_, echo] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("moltzap_template")
      .withUsername("test")
      .withPassword("test")
      .start(),
    startEchoServer(),
  ]);

  pgContainer = pg_;
  echoServer = echo;

  // Phase 2: Apply migrations
  const migrationPool = new pg.Pool({
    connectionString: pgContainer.getConnectionUri(),
  });
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "supabase",
    "migrations",
  );
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    await migrationPool.query(readFileSync(join(migrationsDir, file), "utf-8"));
  }
  await migrationPool.end();

  const pgHost = pgContainer.getHost();
  const pgPort = pgContainer.getMappedPort(5432);

  // Phase 3: Start MoltZap server as subprocess.
  // Dev mode enables JWT DB lookup — connectJwt(supabaseUid) resolves
  // the user by looking up the uid in the users table.
  spawnedServer = await spawnTestServer(pgHost, pgPort);
  const server = spawnedServer;

  // Phase 4: Register container agents via HTTP + DB
  const setupPool = new pg.Pool({
    host: pgHost,
    port: pgPort,
    user: "test",
    password: "test",
    database: server.dbName,
    max: 3,
  });

  async function registerContainerAgent(name: string): Promise<{
    apiKey: string;
    agentId: string;
    userId: string;
    supabaseUid: string;
    claimToken: string;
  }> {
    const res = await fetch(`${server.baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      throw new Error(
        `Register ${name} failed: ${res.status} ${await res.text()}`,
      );
    }
    const reg = (await res.json()) as {
      agentId: string;
      apiKey: string;
      claimToken: string;
    };

    const uid = crypto.randomUUID();
    const phone = `+1555000${crypto.randomUUID().replace(/-/g, "").slice(0, 4)}`;
    const userResult = await setupPool.query(
      `INSERT INTO users (supabase_uid, display_name, phone, phone_hash, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [uid, `User-${name}`, phone, hashPhone(phone)],
    );
    const userId = userResult.rows[0].id as string;

    await setupPool.query(
      `UPDATE agents SET owner_user_id = $1, status = 'active' WHERE claim_token = $2`,
      [userId, reg.claimToken],
    );

    return {
      apiKey: reg.apiKey,
      agentId: reg.agentId,
      userId,
      supabaseUid: uid,
      claimToken: reg.claimToken,
    };
  }

  const [agentA, agentB] = await Promise.all([
    registerContainerAgent("container-agent-a"),
    registerContainerAgent("container-agent-b"),
  ]);

  await setupPool.end();

  // Phase 5: Start OpenClaw containers (parallel)
  const canRunContainers = isImageAvailable();
  if (canRunContainers) {
    const model = echoModelConfig(echo.port);

    containerA = startRawContainer(
      buildOpenClawConfig({
        model,
        serverUrl: server.baseUrl,
        agentApiKey: agentA.apiKey,
        agentName: "container-agent-a",
      }),
      { name: "shared-a", agentName: "container-agent-a" },
    );

    containerB = startRawContainer(
      buildOpenClawConfig({
        model,
        serverUrl: server.baseUrl,
        agentApiKey: agentB.apiKey,
        agentName: "container-agent-b",
      }),
      {
        name: "shared-b",
        agentName: "container-agent-b",
        portRange: [19500, 19999],
      },
    );

    // Start sequentially — parallel container startup can overwhelm Docker on dev machines
    await waitForReady(containerA.containerId);
    await waitForReady(containerB.containerId);
  }

  // Phase 6: Provide all coordinates to test files
  provide("testPgHost", pgHost);
  provide("testPgPort", pgPort);
  provide("echoPort", echo.port);
  provide("testDbName", server.dbName);
  provide("baseUrl", server.baseUrl);
  provide("wsUrl", server.wsUrl);
  provide("containerAId", containerA?.containerId ?? "");
  provide("containerAAgentId", agentA.agentId);
  provide("containerAApiKey", agentA.apiKey);
  provide("containerAUserId", agentA.userId);
  provide("containerASupabaseUid", agentA.supabaseUid);
  provide("containerBId", containerB?.containerId ?? "");
  provide("containerBAgentId", agentB.agentId);
  provide("containerBApiKey", agentB.apiKey);
  provide("containerBUserId", agentB.userId);
  provide("containerBSupabaseUid", agentB.supabaseUid);

  return async () => {
    if (containerA) stopContainer(containerA);
    if (containerB) stopContainer(containerB);
    containerA = null;
    containerB = null;
    if (spawnedServer) await stopSpawnedServer(spawnedServer);
    spawnedServer = null;
    echoServer?.close();
    echoServer = null;
    await pgContainer?.stop();
    pgContainer = null;
  };
}
