/** @file Verifies the rendered NanoClaw container and bridge contract. */

import { assert, it as effectIt } from "@effect/vitest";
import { serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentName,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { Deferred, Effect, Schema, type Scope } from "effect";
import { createServer, type Socket as NetSocket } from "node:net";
import { describe } from "vitest";
import type { NanoClawGateway } from "./gateway.js";
import { type AgentConnection, makeAgentHandle } from "../../network.js";
import {
  type RuntimeAcquisitionError,
  runtimeConfigurationProjection,
  RuntimeFailed,
  type RuntimeTermination,
} from "../agent.js";
import {
  type Application,
  type ContainerRuntime,
  containerRuntimeFor,
  type File,
  image,
} from "../container.js";
import { nanoclawRuntime } from "./runtime.js";

const test = effectIt.effect;
const liveTest = effectIt.scopedLive;
const AGENT_NAME = agentName("alice");
const AGENT_ID = agentId("00000000-0000-4000-8000-000000000001");
const AGENT_KEY_TEXT =
  "moltzap_agent_0000000000000000_000000000000000000000000000000000000000000000000";
const AGENT_KEY = redactedAgentKey(AGENT_KEY_TEXT);
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- the private in-cluster router contract is intentionally HTTP.
const ROUTER_URL = serverBaseUrl("http://router.society.svc:3000");
const APPLICATION_IMAGE = image.make(
  "example.invalid/nanoclaw-application@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const BOOTSTRAP_ROOT = "/var/run/moltzap/bootstrap/";
const RUNTIME_CONFIG_PATH = `${BOOTSTRAP_ROOT}nanoclaw/runtime.json`;
const PROFILE_PATH = `${BOOTSTRAP_ROOT}moltzap/config.json`;
const WORKSPACE_PATH = `${BOOTSTRAP_ROOT}workspace/IDENTITY.md`;
const ENTRYPOINT = "/opt/moltzap/nanoclaw/entrypoint.mjs";
const GATEWAY_PORT = 18_790;
const STATE_DIR = "/var/lib/moltzap/nanoclaw";
const GATEWAY_BIND_HOST = "0.0.0.0";
const BRIDGE_HOST = "127.0.0.2";
const MODEL_ID = "claude-sonnet-4-5";
const WORKSPACE_CONTENT = "Alice";
const MCP_SECRET = "secret-mcp-value";
const MCP_URL = "https://calendar.test/mcp/opaque-token";

const connection: AgentConnection<"alice"> = {
  agent: makeAgentHandle("alice", AGENT_ID),
  key: AGENT_KEY,
  routerUrl: ROUTER_URL,
};

const renderedRuntimeConfig = Schema.parseJson(
  Schema.Struct({
    apiVersion: Schema.Literal("moltzap.nanoclaw-application/v1"),
    agentName: Schema.String,
    gateway: Schema.Struct({ host: Schema.String, port: Schema.Number }),
    stateDirectory: Schema.String,
    workspaceDirectory: Schema.String,
    autoRegisterConversations: Schema.Boolean,
    modelId: Schema.optional(Schema.String),
    mcpServers: Schema.Array(
      Schema.Union(
        Schema.Struct({
          name: Schema.String,
          command: Schema.String,
          args: Schema.Array(Schema.String),
          env: Schema.Record({ key: Schema.String, value: Schema.String }),
        }),
        Schema.Struct({ name: Schema.String, url: Schema.String }),
      ),
    ),
  }),
);

const renderedMoltZapProfile = Schema.parseJson(
  Schema.Struct({
    profiles: Schema.Struct({
      "simulator-agent": Schema.Struct({
        agentId: Schema.String,
        apiKey: Schema.String,
        agentName: Schema.String,
      }),
    }),
  }),
);

type NanoClawContainerRuntime = ContainerRuntime<
  NanoClawGateway,
  RuntimeAcquisitionError
>;
type NanoClawApplication = Application<
  NanoClawGateway,
  RuntimeAcquisitionError
>;

interface Fixture {
  readonly runtime: ReturnType<typeof nanoclawRuntime>;
  readonly capability: NanoClawContainerRuntime;
  readonly application: NanoClawApplication;
  readonly runtimeConfig: typeof renderedRuntimeConfig.Type;
  readonly profile: typeof renderedMoltZapProfile.Type;
}

/**
 * No stop is expected from the runtime, so reporting one is a test defect.
 * @returns An Effect that dies rather than accepting a stop report.
 */
function unreportedStop(): Effect.Effect<never> {
  return Effect.dieMessage("the NanoClaw runtime reported an unexpected stop");
}

function makeFixture() {
  return Effect.gen(function* () {
    const runtime = nanoclawRuntime({
      applicationImage: APPLICATION_IMAGE,
      autoRegisterConversations: true,
      modelId: MODEL_ID,
      workspaceFiles: [
        { relativePath: "IDENTITY.md", content: WORKSPACE_CONTENT },
      ],
      mcpServers: [
        {
          name: "private-tool",
          command: "tool-server",
          args: ["--stdio"],
          env: { PRIVATE_TOKEN: MCP_SECRET },
        },
        { name: "calendar", url: MCP_URL },
      ],
    });
    const capability = containerRuntimeFor(runtime);
    const application = yield* capability.render({
      agentName: AGENT_NAME,
      connection,
    });
    const runtimeConfig = Schema.decodeUnknownSync(renderedRuntimeConfig)(
      requireFile(application.files, RUNTIME_CONFIG_PATH),
    );
    const profile = Schema.decodeUnknownSync(renderedMoltZapProfile)(
      requireFile(application.files, PROFILE_PATH),
    );
    return { runtime, capability, application, runtimeConfig, profile };
  });
}

function assertApplicationContainer(fixture: Fixture): void {
  const { application, capability } = fixture;
  const projection = JSON.stringify({
    entrypoint: application.entrypoint,
    environment: application.environment,
    credentials: application.credentials,
    port: application.port,
  });
  assert.notProperty(application, "containers");
  assert.strictEqual(capability.image, APPLICATION_IMAGE);
  assert.deepStrictEqual(capability.resources, {
    cpuMillis: 1_000,
    memoryBytes: 1_024 * 1_024 * 1_024,
    ephemeralStorageBytes: 1_024 * 1_024 * 1_024,
  });
  assert.deepStrictEqual(application.entrypoint, ["node", ENTRYPOINT]);
  assert.strictEqual(application.port, GATEWAY_PORT);
  assert.strictEqual(application.environment.MOLTZAP_SERVER_URL, ROUTER_URL);
  assert.strictEqual(
    application.environment.MOLTZAP_NANOCLAW_CONFIG,
    RUNTIME_CONFIG_PATH,
  );
  assert.strictEqual(application.environment.MOLTZAP_NANOCLAW_STATE, STATE_DIR);
  assert.deepStrictEqual(application.credentials, ["ANTHROPIC_API_KEY"]);
  assert.notInclude(projection, AGENT_KEY_TEXT);
  assert.notInclude(projection, MCP_SECRET);
}

function assertBootstrap(fixture: Fixture): void {
  const { application, profile, runtime, runtimeConfig } = fixture;
  assert.strictEqual(runtimeConfig.agentName, AGENT_NAME);
  assert.strictEqual(runtimeConfig.gateway.host, GATEWAY_BIND_HOST);
  assert.strictEqual(runtimeConfig.gateway.port, GATEWAY_PORT);
  assert.strictEqual(runtimeConfig.stateDirectory, STATE_DIR);
  assert.strictEqual(runtimeConfig.modelId, MODEL_ID);
  assert.isTrue(runtimeConfig.autoRegisterConversations);
  assert.deepStrictEqual(runtimeConfig.mcpServers, [
    {
      name: "private-tool",
      command: "tool-server",
      args: ["--stdio"],
      env: { PRIVATE_TOKEN: MCP_SECRET },
    },
    { name: "calendar", url: MCP_URL },
  ]);
  assert.strictEqual(profile.profiles["simulator-agent"].agentId, AGENT_ID);
  assert.strictEqual(
    profile.profiles["simulator-agent"].apiKey,
    AGENT_KEY_TEXT,
  );
  assert.strictEqual(
    requireFile(application.files, WORKSPACE_PATH),
    WORKSPACE_CONTENT,
  );
  assert.isTrue(
    application.files.every((file) => file.path.startsWith(BOOTSTRAP_ROOT)),
  );
  assert.notInclude(
    JSON.stringify(runtimeConfigurationProjection(runtime)),
    AGENT_KEY_TEXT,
  );
  assert.notInclude(
    JSON.stringify(runtimeConfigurationProjection(runtime)),
    MCP_URL,
  );
  assert.notInclude(
    JSON.stringify(runtimeConfigurationProjection(runtime)),
    MCP_SECRET,
  );
  assert.notInclude(
    JSON.stringify(runtimeConfigurationProjection(runtime)),
    MCP_URL,
  );
}

function requireFile(files: readonly File[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`missing rendered file ${path}`);
  }
  return file.content;
}

function applicationContractTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture();
    assertApplicationContainer(fixture);
    assertBootstrap(fixture);
  });
}

function rejectedEndpointTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture();
    // A loopback answer is the only address shape the endpoint type still
    // permits, and it must fail before the bridge opens a socket, so the cases
    // stay deterministic without a gateway on the other end.
    for (const host of ["0.0.0.0", "127.0.0.1", "localhost", "::1", "[::1]"]) {
      const failure = yield* Effect.scoped(
        fixture.application.attach(
          { host, port: GATEWAY_PORT },
          Effect.never,
          unreportedStop,
        ),
      ).pipe(Effect.flip);

      assert.strictEqual(failure.agent, AGENT_NAME);
      assert.include(failure.detail, "resolve distributed gateway");
    }
  });
}

function rejectedWorkspacePathTest(): void {
  // Escapes are refused where the runtime is defined, which is before any
  // router credential exists to be written into a bootstrap file.
  for (const relativePath of ["", "../escape.md", "/etc/passwd", "a\\b.md"]) {
    assert.throws(() =>
      nanoclawRuntime({
        applicationImage: APPLICATION_IMAGE,
        workspaceFiles: [{ relativePath, content: WORKSPACE_CONTENT }],
      }),
    );
  }
}

/**
 * Serve the bridge port, and hand back the way to hang up on the controller.
 *
 * The address is a loopback the runtime does not reject: its own validation
 * refuses 127.0.0.1 and localhost, and the cluster reaches an agent by service
 * name in production. The connection is served first because a bridge that
 * never comes up is the acquisition failure the runtime already reports; the
 * regression is a bridge that dies after the controller is attached to it.
 * @returns A function that drops every connection the bridge has accepted.
 */
function startBridge(): Effect.Effect<() => void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const accepted: NetSocket[] = [];
    const server = createServer((socket) => accepted.push(socket));
    yield* Effect.acquireRelease(
      Effect.async<undefined>((resume) => {
        server.listen(GATEWAY_PORT, BRIDGE_HOST, () => {
          resume(Effect.succeed(undefined));
        });
      }),
      () =>
        Effect.sync(() => {
          server.close();
        }),
    );
    return () => {
      for (const socket of accepted) {
        socket.destroy();
      }
    };
  });
}

function gatewayDisconnectTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const reported = yield* Deferred.make<RuntimeTermination>();
    const hangUp = yield* startBridge();

    // The Sandbox observation never completes: the container is still Running
    // as far as the cluster can see, exactly as when only the bridge dies.
    yield* fixture.application.attach(
      { host: BRIDGE_HOST, port: GATEWAY_PORT },
      Effect.never,
      (termination) =>
        Deferred.succeed(reported, termination).pipe(Effect.asVoid),
    );
    yield* Effect.sync(hangUp);
    const termination = yield* Deferred.await(reported);

    assert.instanceOf(termination, RuntimeFailed);
    assert.include(termination.detail, AGENT_NAME);
    assert.include(termination.detail, "disconnected");
  });
}

function descriptorRegistrationTest(): void {
  const runtime = nanoclawRuntime({ applicationImage: APPLICATION_IMAGE });
  assert.isDefined(containerRuntimeFor(runtime));
  assert.notProperty(runtime, "acquire");
}

describe("NanoClaw container runtime", () => {
  test(
    "renders one application container and its closed bootstrap contract",
    applicationContractTest,
  );
  test(
    "refuses any endpoint that is not the runtime's fixed bridge",
    rejectedEndpointTest,
  );
  effectIt(
    "refuses a workspace path that escapes its root when the runtime is defined",
    rejectedWorkspacePathTest,
  );
  liveTest(
    "reports its own bridge disconnecting as the agent's termination",
    gatewayDisconnectTest,
  );
  effectIt(
    "defines metadata and its private capability without a host acquire path",
    descriptorRegistrationTest,
  );
});
