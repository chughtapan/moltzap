import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { RegisterResponse } from "@moltzap/client/auth";
import { registerStandaloneAgentPair } from "@moltzap/client/test-utils";
import { Data, Effect, Redacted } from "effect";
import type { TestProject } from "vitest/node";
import {
  startEchoServer,
  type EchoServer,
} from "./src/__tests__/echo-server.js";
import { echoModelConfig } from "./src/__tests__/openclaw-container.js";
import {
  isImageAvailable,
  buildOpenClawConfig,
  normalizeContainerServerUrl,
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

const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_TEMPLATE_DATABASE = "moltzap_template";
const POSTGRES_TEST_USER = "test";
const POSTGRES_TEST_PASSWORD = "test";
const POSTGRES_PORT = 5432;
const EMPTY_CONTAINER_ID = "";

let pgContainer: StartedPostgreSqlContainer | null = null;
let echoServer: EchoServer | null = null;
let containerA: OpenClawContainer | null = null;
let containerB: OpenClawContainer | null = null;
let spawnedServer: SpawnedServer | null = null;

class OpenClawIntegrationSetupError extends Data.TaggedError(
  "OpenClawIntegrationSetupError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/**
 * Boots the shared OpenClaw integration fixture.
 * @param project Vitest project used to publish fixture values.
 * @returns The integration fixture teardown callback.
 */
export function setup(project: TestProject) {
  const { provide } = project;
  return Effect.runPromise(setupIntegrationTests(provide));
}

function setupIntegrationTests(provide: TestProject["provide"]) {
  return Effect.gen(function* () {
    const prerequisites = yield* startPrerequisites();
    pgContainer = prerequisites.pg;
    echoServer = prerequisites.echo;

    const server = yield* startServer(prerequisites.pg);
    spawnedServer = server;

    const { first: agentA, second: agentB } =
      yield* registerStandaloneAgentPair(server.baseUrl, {
        first: "container-agent-a",
        second: "container-agent-b",
      });

    yield* startOpenClawContainers(prerequisites.echo, server, agentA, agentB);
    provideIntegrationValues(provide, server, agentA, agentB);

    return () => Effect.runPromise(teardownIntegrationTests());
  });
}

function startPrerequisites() {
  return Effect.all(
    {
      pg: startPostgres(),
      echo: startEcho(),
    },
    { concurrency: 2 },
  );
}

function startPostgres(): Effect.Effect<
  StartedPostgreSqlContainer,
  OpenClawIntegrationSetupError
> {
  return Effect.tryPromise({
    try: () =>
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase(POSTGRES_TEMPLATE_DATABASE)
        .withUsername(POSTGRES_TEST_USER)
        .withPassword(POSTGRES_TEST_PASSWORD)
        .start(),
    catch: (cause) =>
      setupError("start PostgreSQL integration container", cause),
  });
}

function startEcho(): Effect.Effect<EchoServer, OpenClawIntegrationSetupError> {
  return Effect.tryPromise({
    try: () => startEchoServer(),
    catch: (cause) => setupError("start echo model server", cause),
  });
}

function startServer(
  pg: StartedPostgreSqlContainer,
): Effect.Effect<SpawnedServer, OpenClawIntegrationSetupError> {
  return Effect.tryPromise({
    try: () => spawnTestServer(pg.getHost(), pg.getMappedPort(POSTGRES_PORT)),
    catch: (cause) => setupError("start MoltZap test server", cause),
  });
}

function startSharedOpenClawContainer(input: {
  readonly model: ReturnType<typeof echoModelConfig>;
  readonly server: SpawnedServer;
  readonly slot: "shared-a" | "shared-b";
  readonly agentName: string;
  readonly agent: RegisterResponse;
  readonly portRange?: [number, number];
}) {
  return startRawContainer(
    buildOpenClawConfig({
      model: input.model,
      agentName: input.agentName,
    }),
    {
      name: input.slot,
      agentName: input.agentName,
      moltzapProfile: {
        agentId: input.agent.agentId,
        apiKey: input.agent.apiKey,
      },
      envVars: {
        MOLTZAP_SERVER_URL: normalizeContainerServerUrl(input.server.baseUrl),
      },
      ...(input.portRange !== undefined ? { portRange: input.portRange } : {}),
    },
  );
}

function startOpenClawContainers(
  echo: EchoServer,
  server: SpawnedServer,
  agentA: RegisterResponse,
  agentB: RegisterResponse,
) {
  if (!isImageAvailable()) {
    return Effect.void;
  }
  const model = echoModelConfig(echo.port);
  return Effect.gen(function* () {
    const [firstContainer, secondContainer] = yield* Effect.all(
      [
        startSharedOpenClawContainer({
          model,
          server,
          slot: "shared-a",
          agentName: "container-agent-a",
          agent: agentA,
        }),
        startSharedOpenClawContainer({
          model,
          server,
          slot: "shared-b",
          agentName: "container-agent-b",
          agent: agentB,
          portRange: [19500, 19999],
        }),
      ],
      { concurrency: 2 },
    );

    containerA = firstContainer;
    containerB = secondContainer;

    yield* waitForContainer(firstContainer);
    yield* waitForContainer(secondContainer);
  });
}

function waitForContainer(
  container: OpenClawContainer,
): Effect.Effect<void, OpenClawIntegrationSetupError> {
  return Effect.tryPromise({
    try: () => waitForReady(container.containerId),
    catch: (cause) =>
      setupError(`wait for OpenClaw container ${container.containerId}`, cause),
  });
}

function provideIntegrationValues(
  provide: TestProject["provide"],
  server: SpawnedServer,
  agentA: RegisterResponse,
  agentB: RegisterResponse,
): void {
  provide("baseUrl", server.baseUrl);
  provide("wsUrl", server.wsUrl);
  provide("containerAId", containerA?.containerId ?? EMPTY_CONTAINER_ID);
  provide("containerAAgentId", agentA.agentId);
  provide("containerAApiKey", Redacted.value(agentA.apiKey));
  provide("containerBId", containerB?.containerId ?? EMPTY_CONTAINER_ID);
  provide("containerBAgentId", agentB.agentId);
  provide("containerBApiKey", Redacted.value(agentB.apiKey));
}

function teardownIntegrationTests() {
  return Effect.gen(function* () {
    const firstContainer = containerA;
    containerA = null;
    if (firstContainer !== null) {
      yield* stopContainer(firstContainer);
    }

    const secondContainer = containerB;
    containerB = null;
    if (secondContainer !== null) {
      yield* stopContainer(secondContainer);
    }

    const server = spawnedServer;
    spawnedServer = null;
    if (server !== null) {
      yield* stopServer(server);
    }

    echoServer?.close();
    echoServer = null;

    const postgres = pgContainer;
    pgContainer = null;
    if (postgres !== null) {
      yield* stopPostgres(postgres);
    }
  });
}

function stopServer(
  server: SpawnedServer,
): Effect.Effect<void, OpenClawIntegrationSetupError> {
  return Effect.tryPromise({
    try: () => stopSpawnedServer(server),
    catch: (cause) => setupError("stop MoltZap test server", cause),
  });
}

function stopPostgres(
  pg: StartedPostgreSqlContainer,
): Effect.Effect<void, OpenClawIntegrationSetupError> {
  return Effect.tryPromise({
    try: () => pg.stop(),
    catch: (cause) =>
      setupError("stop PostgreSQL integration container", cause),
  });
}

function setupError(
  operation: string,
  cause: unknown,
): OpenClawIntegrationSetupError {
  return new OpenClawIntegrationSetupError({ operation, cause });
}
