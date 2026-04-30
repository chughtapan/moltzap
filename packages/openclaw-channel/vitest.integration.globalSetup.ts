import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
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

  const pgHost = pgContainer.getHost();
  const pgPort = pgContainer.getMappedPort(5432);

  // Phase 2: Start MoltZap server as subprocess. The server's standalone
  // entry runs `autoMigrate` against the freshly-cloned per-test database,
  // applying core-schema.sql AND seeding the KEK from
  // ENCRYPTION_MASTER_SECRET. Pre-applying the schema in this setup would
  // cause the server's autoMigrate to skip KEK seeding (it short-circuits
  // when the `agents` table already exists), so we leave the template empty.
  spawnedServer = await spawnTestServer(pgHost, pgPort);
  const server = spawnedServer;

  // Phase 3: Register container agents via HTTP
  async function registerContainerAgent(name: string): Promise<{
    apiKey: string;
    agentId: string;
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
    return (await res.json()) as {
      agentId: string;
      apiKey: string;
      claimToken: string;
    };
  }

  const [agentA, agentB] = await Promise.all([
    registerContainerAgent("container-agent-a"),
    registerContainerAgent("container-agent-b"),
  ]);

  // Phase 4: Start OpenClaw containers (parallel)
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

  // Phase 5: Provide all coordinates to test files
  provide("baseUrl", server.baseUrl);
  provide("wsUrl", server.wsUrl);
  provide("containerAId", containerA?.containerId ?? "");
  provide("containerAAgentId", agentA.agentId);
  provide("containerAApiKey", agentA.apiKey);
  provide("containerBId", containerB?.containerId ?? "");
  provide("containerBAgentId", agentB.agentId);
  provide("containerBApiKey", agentB.apiKey);

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
