import { serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentName,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { assert, it as effectIt } from "@effect/vitest";
import { Duration, Effect, Schema, Stream } from "effect";
import { describe } from "vitest";
import { makeAgentHandle, type AgentConnection } from "../../network.js";
import {
  distributedRuntimeCapability,
  type DistributedApplicationAttachment,
  type DistributedContainerImage,
  type DistributedRuntimeApplication,
  type DistributedRuntimeCapability,
} from "../distributed.js";
import type { RuntimeAcquisitionFailed } from "../process.js";
import { RuntimeExited, runtimeConfigurationProjection } from "../runtime.js";
import type { NanoclawGateway, NanoclawGatewaySession } from "./gateway.js";
import {
  makeNanoclawDistributedCapabilityWith,
  nanoclawRuntime,
} from "./runtime.js";

const test = effectIt.effect;
const AGENT_NAME = agentName("alice");
const AGENT_ID = agentId("00000000-0000-4000-8000-000000000001");
const AGENT_KEY_TEXT =
  "moltzap_agent_0000000000000000_000000000000000000000000000000000000000000000000";
const AGENT_KEY = redactedAgentKey(AGENT_KEY_TEXT);
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- the private in-cluster router contract is intentionally HTTP.
const ROUTER_URL = serverBaseUrl("http://router.society.svc:3000");
const APPLICATION_IMAGE =
  "example.invalid/nanoclaw-application@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" satisfies DistributedContainerImage;
const SUPPORT_IMAGE =
  "example.invalid/moltzap-support@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" satisfies DistributedContainerImage;
const BOOTSTRAP_SECRET_IDENTITY = "alice-bootstrap";
const BOOTSTRAP_ROOT = "/var/run/moltzap/bootstrap/";
const RUNTIME_CONFIG_PATH = `${BOOTSTRAP_ROOT}nanoclaw/runtime.json`;
const PROFILE_PATH = `${BOOTSTRAP_ROOT}moltzap/config.json`;
const WORKSPACE_PATH = `${BOOTSTRAP_ROOT}workspace/IDENTITY.md`;
const DISTRIBUTED_ENTRYPOINT = "/opt/moltzap/nanoclaw/entrypoint.mjs";
const DISTRIBUTED_GATEWAY_PORT = 18_790;
const DISTRIBUTED_STATE_DIR = "/var/lib/moltzap/nanoclaw";
const GATEWAY_BIND_HOST = "0.0.0.0";
const GATEWAY_HOST = "alice.society.svc";
const GATEWAY_URL = `ws://${GATEWAY_HOST}:${String(DISTRIBUTED_GATEWAY_PORT)}`;
const MODEL_ID = "claude-sonnet-4-5";
const WORKSPACE_CONTENT = "Alice";
const READINESS_MARKER = "NanoClaw distributed bridge ready";
const BRIDGE_TIMEOUT = Duration.seconds(19);
const BRIDGE_TIMEOUT_MILLIS = 19_000;
const MCP_SECRET = "secret-mcp-value";

const connection: AgentConnection<"alice"> = {
  agent: makeAgentHandle("alice", AGENT_ID),
  key: AGENT_KEY,
  routerUrl: ROUTER_URL,
};

const PRINCIPAL_GATEWAY: NanoclawGateway = Object.freeze({
  submit: () => Effect.void,
  outputs: Stream.empty,
});

const PRINCIPAL_SESSION: NanoclawGatewaySession = Object.freeze({
  gateway: PRINCIPAL_GATEWAY,
  failure: Effect.never,
});

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
      Schema.Struct({
        name: Schema.String,
        command: Schema.String,
        args: Schema.Array(Schema.String),
        env: Schema.Record({ key: Schema.String, value: Schema.String }),
      }),
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

type NanoclawDistributedCapability = DistributedRuntimeCapability<
  NanoclawGateway,
  RuntimeAcquisitionFailed
>;
type NanoclawDistributedApplication = DistributedRuntimeApplication<
  NanoclawGateway,
  RuntimeAcquisitionFailed
>;

interface Fixture {
  readonly runtime: ReturnType<typeof nanoclawRuntime>;
  readonly capability: NanoclawDistributedCapability;
  readonly application: NanoclawDistributedApplication;
  readonly runtimeConfig: typeof renderedRuntimeConfig.Type;
  readonly profile: typeof renderedMoltZapProfile.Type;
}

function requireFile(
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
  path: string,
): string {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`missing rendered file ${path}`);
  }
  return file.content;
}

function requireCapability(
  runtime: ReturnType<typeof nanoclawRuntime>,
): NanoclawDistributedCapability {
  const capability = distributedRuntimeCapability(runtime);
  if (capability === undefined) {
    throw new Error(
      "configured NanoClaw runtime has no distributed capability",
    );
  }
  return capability;
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
      ],
    });
    const capability = requireCapability(runtime);
    const application = yield* capability.render(
      { agentName: AGENT_NAME, connection },
      {
        supportImage: SUPPORT_IMAGE,
        bootstrapSecretIdentity: BOOTSTRAP_SECRET_IDENTITY,
      },
    );
    const runtimeConfig = Schema.decodeUnknownSync(renderedRuntimeConfig)(
      requireFile(application.bootstrapSecret.files, RUNTIME_CONFIG_PATH),
    );
    const profile = Schema.decodeUnknownSync(renderedMoltZapProfile)(
      requireFile(application.bootstrapSecret.files, PROFILE_PATH),
    );
    return { runtime, capability, application, runtimeConfig, profile };
  });
}

function assertApplicationContainer(fixture: Fixture): void {
  const { application, capability } = fixture;
  const container = application.applicationContainer;
  const projection = JSON.stringify(container);
  assert.notProperty(application, "containers");
  assert.strictEqual(container.image, APPLICATION_IMAGE);
  assert.strictEqual(container.image, capability.reservation.image);
  assert.deepStrictEqual(container.resources, capability.reservation.resources);
  assert.deepStrictEqual(capability.reservation.resources, {
    cpuMillis: 1_000,
    memoryBytes: 1_024 * 1_024 * 1_024,
    ephemeralStorageBytes: 1_024 * 1_024 * 1_024,
  });
  assert.deepStrictEqual(container.entrypoint, [
    "node",
    DISTRIBUTED_ENTRYPOINT,
  ]);
  assert.deepStrictEqual(container.ports, [DISTRIBUTED_GATEWAY_PORT]);
  assert.strictEqual(container.environment.MOLTZAP_SERVER_URL, ROUTER_URL);
  assert.strictEqual(
    container.environment.MOLTZAP_NANOCLAW_CONFIG,
    RUNTIME_CONFIG_PATH,
  );
  assert.strictEqual(
    container.environment.MOLTZAP_NANOCLAW_STATE,
    DISTRIBUTED_STATE_DIR,
  );
  assert.deepStrictEqual(container.credentialEnvironment, [
    "ANTHROPIC_API_KEY",
  ]);
  assert.notInclude(projection, AGENT_KEY_TEXT);
  assert.notInclude(projection, MCP_SECRET);
}

function assertBootstrap(fixture: Fixture): void {
  const { application, profile, runtime, runtimeConfig } = fixture;
  assert.strictEqual(runtimeConfig.agentName, AGENT_NAME);
  assert.strictEqual(runtimeConfig.gateway.host, GATEWAY_BIND_HOST);
  assert.strictEqual(runtimeConfig.gateway.port, DISTRIBUTED_GATEWAY_PORT);
  assert.strictEqual(runtimeConfig.stateDirectory, DISTRIBUTED_STATE_DIR);
  assert.strictEqual(runtimeConfig.modelId, MODEL_ID);
  assert.isTrue(runtimeConfig.autoRegisterConversations);
  assert.strictEqual(
    runtimeConfig.mcpServers[0]?.env.PRIVATE_TOKEN,
    MCP_SECRET,
  );
  assert.strictEqual(profile.profiles["simulator-agent"].agentId, AGENT_ID);
  assert.strictEqual(
    profile.profiles["simulator-agent"].apiKey,
    AGENT_KEY_TEXT,
  );
  assert.strictEqual(
    requireFile(application.bootstrapSecret.files, WORKSPACE_PATH),
    WORKSPACE_CONTENT,
  );
  assert.isTrue(
    application.bootstrapSecret.files.every((file) =>
      file.path.startsWith(BOOTSTRAP_ROOT),
    ),
  );
  assert.strictEqual(
    application.bootstrapSecret.identity,
    BOOTSTRAP_SECRET_IDENTITY,
  );
  assert.strictEqual(application.bootstrapSecret.supportImage, SUPPORT_IMAGE);
  assert.strictEqual(application.readiness.outputIncludes, READINESS_MARKER);
  assert.notInclude(
    JSON.stringify(runtimeConfigurationProjection(runtime)),
    AGENT_KEY_TEXT,
  );
  assert.notInclude(
    JSON.stringify(runtimeConfigurationProjection(runtime)),
    MCP_SECRET,
  );
}

function applicationContractTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture();
    assertApplicationContainer(fixture);
    assertBootstrap(fixture);
  });
}

function exactBridgeTest() {
  return Effect.gen(function* () {
    let observedEndpoint:
      | { readonly host: string; readonly port: number }
      | undefined;
    let observedTimeout: Duration.Duration | undefined;
    const capability = makeNanoclawDistributedCapabilityWith(
      {
        applicationImage: APPLICATION_IMAGE,
        startupTimeout: BRIDGE_TIMEOUT,
      },
      (endpoint, within) =>
        Effect.sync(() => {
          observedEndpoint = endpoint;
          observedTimeout = within;
          return PRINCIPAL_SESSION;
        }),
    );
    const application = yield* capability.render(
      { agentName: AGENT_NAME, connection },
      {
        supportImage: SUPPORT_IMAGE,
        bootstrapSecretIdentity: BOOTSTRAP_SECRET_IDENTITY,
      },
    );
    const termination = RuntimeExited.make({ code: 17 });
    const attachment: DistributedApplicationAttachment = {
      endpointUrl: GATEWAY_URL,
      stopped: Effect.never,
      termination: Effect.succeed(termination),
    };
    const running = yield* Effect.scoped(application.attach(attachment));

    assert.strictEqual(running.gateway, PRINCIPAL_GATEWAY);
    assert.deepStrictEqual(yield* running.termination, termination);
    assert.deepStrictEqual(observedEndpoint, {
      host: GATEWAY_HOST,
      port: DISTRIBUTED_GATEWAY_PORT,
    });
    assert.strictEqual(
      observedTimeout === undefined
        ? undefined
        : Duration.toMillis(observedTimeout),
      BRIDGE_TIMEOUT_MILLIS,
    );
  });
}

function descriptorRegistrationTest(): void {
  const runtime = nanoclawRuntime({ applicationImage: APPLICATION_IMAGE });
  assert.isDefined(distributedRuntimeCapability(runtime));
  assert.notProperty(runtime, "acquire");
}

describe("distributed NanoClaw runtime", () => {
  test(
    "renders one application container and its closed bootstrap contract",
    applicationContractTest,
  );
  test(
    "attaches the exact native gateway over its fixed bridge",
    exactBridgeTest,
  );
  effectIt(
    "defines metadata and its private capability without a host acquire path",
    descriptorRegistrationTest,
  );
});
