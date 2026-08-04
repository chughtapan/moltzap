import { assert, it as effectIt } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { describe } from "vitest";
import { makeAgentHandle, type AgentConnection } from "../../network.js";
import {
  distributedRuntimeCapability,
  type DistributedApplicationAttachment,
  type DistributedRuntimeApplication,
  type DistributedRuntimeCapability,
} from "../distributed.js";
import type { RuntimeAcquisitionFailed } from "../process.js";
import { RuntimeExited, runtimeConfigurationProjection } from "../runtime.js";
import {
  OpenClawGatewaySucceeded,
  type OpenClawGateway,
  type OpenClawGatewaySession,
} from "./gateway.js";
import {
  makeOpenClawDistributedCapabilityWith,
  openClawRuntime,
} from "./runtime.js";
import { serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentName,
  redactedAgentKey,
} from "@moltzap/protocol/testing";

const test = effectIt.effect;
const AGENT_NAME = agentName("alice");
const AGENT_ID = agentId("00000000-0000-4000-8000-000000000001");
const AGENT_KEY_TEXT =
  "moltzap_agent_0000000000000000_000000000000000000000000000000000000000000000000";
const AGENT_KEY = redactedAgentKey(AGENT_KEY_TEXT);
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- the private in-cluster router contract is intentionally HTTP.
const ROUTER_URL = serverBaseUrl("http://router.society.svc:3000");
const GATEWAY_URL = "ws://alice.society.svc:18789";
const SUPPORT_IMAGE =
  "example.invalid/moltzap-support@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOOTSTRAP_SECRET_IDENTITY = "alice-bootstrap";
const BOOTSTRAP_ROOT = "/var/run/moltzap/bootstrap/";
const OPENCLAW_CONFIG_PATH = `${BOOTSTRAP_ROOT}openclaw.json`;
const PROFILE_PATH = `${BOOTSTRAP_ROOT}moltzap/config.json`;
const CHANNEL_PATH = `${BOOTSTRAP_ROOT}openclaw-channel`;
const WORKSPACE_PATH = `${BOOTSTRAP_ROOT}workspace/IDENTITY.md`;
const DISTRIBUTED_GATEWAY_PORT = 18_789;
const APPLICATION_STATE_DIR = `${BOOTSTRAP_ROOT}state`;
const PAIRED_DEVICES_PATH = `${APPLICATION_STATE_DIR}/devices/paired.json`;
const WORKSPACE_CONTENT = "Alice";
const READINESS_MARKER = "connected as";

const connection: AgentConnection<"alice"> = {
  agent: makeAgentHandle("alice", AGENT_ID),
  key: AGENT_KEY,
  routerUrl: ROUTER_URL,
};

const PRINCIPAL_GATEWAY: OpenClawGateway = Object.freeze({
  agent: () =>
    Effect.succeed(
      OpenClawGatewaySucceeded.make({
        runId: "unused",
        status: "ok",
        summary: "completed",
        result: {},
      }),
    ),
});

const renderedOpenClawConfig = Schema.parseJson(
  Schema.Struct({
    agents: Schema.Struct({
      defaults: Schema.Struct({ workspace: Schema.String }),
    }),
    gateway: Schema.Struct({
      bind: Schema.String,
      auth: Schema.Struct({ token: Schema.String }),
    }),
    plugins: Schema.Struct({
      load: Schema.Struct({ paths: Schema.Array(Schema.String) }),
    }),
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

type OpenClawDistributedCapability = DistributedRuntimeCapability<
  OpenClawGateway,
  RuntimeAcquisitionFailed
>;
type OpenClawDistributedApplication = DistributedRuntimeApplication<
  OpenClawGateway,
  RuntimeAcquisitionFailed
>;

interface StockFixture {
  readonly runtime: ReturnType<typeof openClawRuntime>;
  readonly capability: OpenClawDistributedCapability;
  readonly application: OpenClawDistributedApplication;
  readonly config: typeof renderedOpenClawConfig.Type;
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
  runtime: ReturnType<typeof openClawRuntime>,
): OpenClawDistributedCapability {
  const capability = distributedRuntimeCapability(runtime);
  if (capability === undefined) {
    throw new Error("stock OpenClaw runtime has no distributed capability");
  }
  return capability;
}

function makeStockFixture() {
  return Effect.gen(function* () {
    const runtime = openClawRuntime({
      modelId: "openai/gpt-5.5",
      workspaceFiles: [
        { relativePath: "IDENTITY.md", content: WORKSPACE_CONTENT },
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
    const config = Schema.decodeUnknownSync(renderedOpenClawConfig)(
      requireFile(application.bootstrapSecret.files, OPENCLAW_CONFIG_PATH),
    );
    const profile = Schema.decodeUnknownSync(renderedMoltZapProfile)(
      requireFile(application.bootstrapSecret.files, PROFILE_PATH),
    );
    return { runtime, capability, application, config, profile };
  });
}

function assertCredentialFreeReservation(
  capability: OpenClawDistributedCapability,
): void {
  const reservation = JSON.stringify(capability.reservation).toLowerCase();
  assert.notInclude(reservation, AGENT_KEY_TEXT.toLowerCase());
  assert.notInclude(reservation, "credential");
  assert.notInclude(reservation, "bootstrap");
  assert.match(capability.reservation.image, /@sha256:[\da-f]{64}$/u);
}

function assertApplicationContainer(fixture: StockFixture): void {
  const { application, capability, config } = fixture;
  const container = application.applicationContainer;
  const containerProjection = JSON.stringify(container);
  assert.notProperty(application, "containers");
  assert.notProperty(application, "applicationContainers");
  assert.strictEqual(container.image, capability.reservation.image);
  assert.deepStrictEqual(container.resources, capability.reservation.resources);
  assert.deepStrictEqual(capability.reservation.resources, {
    cpuMillis: 1_000,
    memoryBytes: 1_024 * 1_024 * 1_024,
    ephemeralStorageBytes: 1_024 * 1_024 * 1_024,
  });
  assert.deepStrictEqual(container.entrypoint, [
    "node",
    "/app/openclaw.mjs",
    "gateway",
    "run",
    "--allow-unconfigured",
    "--port",
    String(DISTRIBUTED_GATEWAY_PORT),
  ]);
  assert.deepStrictEqual(container.ports, [DISTRIBUTED_GATEWAY_PORT]);
  assert.strictEqual(
    container.environment.OPENCLAW_CONFIG_PATH,
    OPENCLAW_CONFIG_PATH,
  );
  assert.strictEqual(
    container.environment.OPENCLAW_STATE_DIR,
    APPLICATION_STATE_DIR,
  );
  assert.strictEqual(container.environment.MOLTZAP_SERVER_URL, ROUTER_URL);
  assert.deepStrictEqual(container.credentialEnvironment, ["OPENAI_API_KEY"]);
  assert.notInclude(containerProjection, AGENT_KEY_TEXT);
  assert.notInclude(containerProjection, config.gateway.auth.token);
  assert.strictEqual(config.gateway.bind, "lan");
  assert.strictEqual(
    config.agents.defaults.workspace,
    `${BOOTSTRAP_ROOT}workspace`,
  );
  assert.deepStrictEqual(config.plugins.load.paths, [CHANNEL_PATH]);
}

function assertBootstrapMaterial(fixture: StockFixture): void {
  const { application, profile, runtime } = fixture;
  assert.strictEqual(profile.profiles["simulator-agent"].agentId, AGENT_ID);
  assert.strictEqual(
    profile.profiles["simulator-agent"].apiKey,
    AGENT_KEY_TEXT,
  );
  assert.strictEqual(profile.profiles["simulator-agent"].agentName, AGENT_NAME);
  assert.strictEqual(
    requireFile(application.bootstrapSecret.files, WORKSPACE_PATH),
    WORKSPACE_CONTENT,
  );
  const pairedDevices = JSON.parse(
    requireFile(application.bootstrapSecret.files, PAIRED_DEVICES_PATH),
  ) as Record<string, { readonly approvedScopes: readonly string[] }>;
  assert.lengthOf(Object.keys(pairedDevices), 1);
  assert.deepStrictEqual(
    Object.values(pairedDevices)[0]?.approvedScopes,
    ["operator.write"],
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
}

function stockCapabilityTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeStockFixture();
    assertCredentialFreeReservation(fixture.capability);
    assertApplicationContainer(fixture);
    assertBootstrapMaterial(fixture);
  });
}

function exactBridgeTest() {
  return Effect.gen(function* () {
    let observedSession: OpenClawGatewaySession | undefined;
    const capability = makeOpenClawDistributedCapabilityWith({}, (session) =>
      Effect.sync(() => {
        observedSession = session;
        return PRINCIPAL_GATEWAY;
      }),
    );
    const application = yield* capability.render(
      { agentName: AGENT_NAME, connection },
      {
        supportImage: SUPPORT_IMAGE,
        bootstrapSecretIdentity: BOOTSTRAP_SECRET_IDENTITY,
      },
    );
    const termination = Effect.succeed(RuntimeExited.make({ code: 17 }));
    const attachment: DistributedApplicationAttachment = {
      endpointUrl: GATEWAY_URL,
      stopped: Effect.never,
      termination,
    };
    const running = yield* Effect.scoped(application.attach(attachment));
    const config = Schema.decodeUnknownSync(renderedOpenClawConfig)(
      requireFile(application.bootstrapSecret.files, OPENCLAW_CONFIG_PATH),
    );

    assert.strictEqual(running.gateway, PRINCIPAL_GATEWAY);
    assert.strictEqual(running.termination, termination);
    assert.isDefined(observedSession);
    assert.strictEqual(observedSession?.gatewayUrl, `${GATEWAY_URL}/`);
    assert.strictEqual(
      observedSession === undefined
        ? undefined
        : Redacted.value(observedSession.gatewayToken),
      config.gateway.auth.token,
    );
    assert.match(
      observedSession?.deviceIdentity.deviceId ?? "",
      /^[\da-f]{64}$/u,
    );
  });
}

describe("distributed OpenClaw runtime", () => {
  test(
    "renders one stock application container with credentials confined to bootstrap files",
    stockCapabilityTest,
  );
  test(
    "attaches the exact native gateway and termination observation",
    exactBridgeTest,
  );
});
