/** @file OpenClaw container rendering, bootstrap isolation, and gateway attachment regressions. */

import { assert, it as effectIt } from "@effect/vitest";
import { AgentName } from "@moltzap/identity";
import { Effect, Schema } from "effect";
import { describe } from "vitest";
import {
  type RuntimeAcquisitionError,
  runtimeConfigurationProjection,
} from "../agent.js";
import {
  type Application,
  type ContainerRuntime,
  containerRuntimeFor,
  type File,
} from "../container.js";
import {
  GatewayOperations,
  type OpenClawGateway,
  type OpenClawGatewayClientFactory,
  OpenClawGatewayRequest,
  OpenClawGatewaySucceeded,
} from "./gateway.js";
import { openClawRuntime } from "./runtime.js";

const test = effectIt.effect;
const AGENT_NAME = Schema.decodeUnknownSync(AgentName)("alice");
const GATEWAY_HOST = "alice.society.svc";
const BOOTSTRAP_ROOT = "/var/run/moltzap/bootstrap/";
const OPENCLAW_CONFIG_PATH = `${BOOTSTRAP_ROOT}openclaw.json`;
const OPENCLAW_EXTENSION_PATH = `${BOOTSTRAP_ROOT}openclaw-channel`;
const WORKSPACE_PATH = `${BOOTSTRAP_ROOT}workspace/IDENTITY.md`;
const GATEWAY_PORT = 18_789;
const APPLICATION_STATE_DIR = `${BOOTSTRAP_ROOT}state`;
const PAIRED_DEVICES_PATH = `${APPLICATION_STATE_DIR}/devices/paired.json`;
const WORKSPACE_CONTENT = "Alice";
const BRIDGE_RUN_ID = "openclaw-bridge-run";
const BRIDGE_IDEMPOTENCY_KEY = "openclaw-bridge-key";
const messagingModeProjection = Schema.Struct({
  messagingMode: Schema.Literal("shared", "private"),
});

/**
 * OpenClaw sees no stop the cluster cannot, so it must never report one: its
 * gateway is request-response over a connection the bridge client owns, not a
 * connection the runtime holds open and watches.
 * @returns An Effect that fails the test if the runtime ever reports a stop.
 */
function unreportedStop(): Effect.Effect<never> {
  return Effect.dieMessage("the OpenClaw runtime reported an unexpected stop");
}

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
      entries: Schema.Struct({
        "openclaw-channel": Schema.Struct({ enabled: Schema.Boolean }),
      }),
      load: Schema.optional(
        Schema.Struct({ paths: Schema.Array(Schema.String) }),
      ),
    }),
    session: Schema.optional(
      Schema.Struct({
        dmScope: Schema.Literal("per-account-channel-peer"),
      }),
    ),
    channels: Schema.Struct({
      moltzap: Schema.Struct({
        accounts: Schema.Array(
          Schema.Struct({
            id: Schema.String,
          }),
        ),
      }),
    }),
    messages: Schema.Struct({
      queue: Schema.Struct({
        mode: Schema.Literal("steer"),
        cap: Schema.Number,
        drop: Schema.Literal("new"),
      }),
      inbound: Schema.Struct({ debounceMs: Schema.Number }),
    }),
  }),
);

type OpenClawContainerRuntime = ContainerRuntime<
  OpenClawGateway,
  RuntimeAcquisitionError
>;
type OpenClawApplication = Application<
  OpenClawGateway,
  RuntimeAcquisitionError
>;

interface OpenClawContainerFixture {
  readonly runtime: ReturnType<typeof openClawRuntime>;
  readonly capability: OpenClawContainerRuntime;
  readonly application: OpenClawApplication;
  readonly config: typeof renderedOpenClawConfig.Type;
}

function applicationContainerTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeOpenClawContainerFixture();
    assertCredentialFreeReservation(fixture.capability);
    assertApplicationContainer(fixture);
    assertBootstrapMaterial(fixture);
  });
}

function makeOpenClawContainerFixture() {
  return Effect.gen(function* () {
    const runtime = openClawRuntime({
      modelId: "openai/gpt-5.5",
      workspaceFiles: [
        { relativePath: "IDENTITY.md", content: WORKSPACE_CONTENT },
      ],
    });
    const capability = containerRuntimeFor(runtime);
    const application = yield* capability.render({ agentName: AGENT_NAME });
    const config = Schema.decodeUnknownSync(renderedOpenClawConfig)(
      requireFile(application.files, OPENCLAW_CONFIG_PATH),
    );
    return { runtime, capability, application, config };
  });
}

function assertCredentialFreeReservation(
  capability: OpenClawContainerRuntime,
): void {
  const reservation = JSON.stringify({
    image: capability.image,
    resources: capability.resources,
  }).toLowerCase();
  assert.notInclude(reservation, "credential");
  assert.notInclude(reservation, "bootstrap");
  assert.strictEqual(
    capability.image,
    "ghcr.io/openclaw/openclaw@sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4",
  );
}

function assertApplicationContainer(fixture: OpenClawContainerFixture): void {
  const { application, capability, config } = fixture;
  const containerProjection = JSON.stringify({
    entrypoint: application.entrypoint,
    environment: application.environment,
    credentials: application.credentials,
    port: application.port,
  });
  assert.notProperty(application, "containers");
  assert.notProperty(application, "applicationContainers");
  assert.deepStrictEqual(capability.resources, {
    cpuMillis: 1_000,
    memoryBytes: 1_024 * 1_024 * 1_024,
    ephemeralStorageBytes: 1_024 * 1_024 * 1_024,
  });
  assert.deepStrictEqual(application.entrypoint, [
    "node",
    "/app/openclaw.mjs",
    "gateway",
    "run",
    "--allow-unconfigured",
    "--port",
    String(GATEWAY_PORT),
  ]);
  assert.strictEqual(application.port, GATEWAY_PORT);
  assert.strictEqual(
    application.environment.OPENCLAW_CONFIG_PATH,
    OPENCLAW_CONFIG_PATH,
  );
  assert.strictEqual(
    application.environment.OPENCLAW_STATE_DIR,
    APPLICATION_STATE_DIR,
  );
  assert.deepStrictEqual(application.credentials, ["OPENAI_API_KEY"]);
  assert.notInclude(containerProjection, config.gateway.auth.token);
  assert.strictEqual(config.gateway.bind, "lan");
  assert.strictEqual(
    config.agents.defaults.workspace,
    `${BOOTSTRAP_ROOT}workspace`,
  );
  assertMessagingConfiguration(fixture);
}

function assertMessagingConfiguration(fixture: OpenClawContainerFixture): void {
  const { config, runtime } = fixture;
  assert.deepStrictEqual(config.plugins.entries, {
    "openclaw-channel": { enabled: true },
  });
  assert.deepStrictEqual(config.plugins.load, {
    paths: [OPENCLAW_EXTENSION_PATH],
  });
  assert.notProperty(config, "session");
  assert.deepStrictEqual(config.channels.moltzap.accounts, [
    { id: "simulator-agent" },
  ]);
  assert.deepStrictEqual(config.messages, {
    queue: { mode: "steer", cap: 100, drop: "new" },
    inbound: { debounceMs: 0 },
  });
  assert.strictEqual(
    Schema.decodeUnknownSync(messagingModeProjection)(
      runtimeConfigurationProjection(runtime),
    ).messagingMode,
    "shared",
  );
}

function privateMessagingModeTest() {
  return Effect.gen(function* () {
    const runtime = openClawRuntime({ messagingMode: "private" });
    const capability = containerRuntimeFor(runtime);
    const application = yield* capability.render({ agentName: AGENT_NAME });
    const config = Schema.decodeUnknownSync(renderedOpenClawConfig)(
      requireFile(application.files, OPENCLAW_CONFIG_PATH),
    );

    assert.deepStrictEqual(config.channels.moltzap.accounts, [
      { id: "simulator-agent" },
    ]);
    assert.deepStrictEqual(config.session, {
      dmScope: "per-account-channel-peer",
    });
    assert.strictEqual(
      Schema.decodeUnknownSync(messagingModeProjection)(
        runtimeConfigurationProjection(runtime),
      ).messagingMode,
      "private",
    );
  });
}

function assertBootstrapMaterial(fixture: OpenClawContainerFixture): void {
  const { application } = fixture;
  assert.strictEqual(
    requireFile(application.files, WORKSPACE_PATH),
    WORKSPACE_CONTENT,
  );
  const pairedDevices =
    /* Safe because the same render call generated this file's JSON. */
    JSON.parse(requireFile(application.files, PAIRED_DEVICES_PATH)) as Record<
      string,
      { readonly approvedScopes: readonly string[] }
    >;
  assert.lengthOf(Object.keys(pairedDevices), 1);
  assert.deepStrictEqual(Object.values(pairedDevices)[0]?.approvedScopes, [
    "operator.write",
  ]);
  assert.isTrue(
    application.files.every((file) => file.path.startsWith(BOOTSTRAP_ROOT)),
  );
}

function requireFile(files: readonly File[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`missing rendered file ${path}`);
  }
  return file.content;
}

interface ObservedClient {
  options?: Parameters<OpenClawGatewayClientFactory>[0];
}

function bridgeClient(observed: ObservedClient): OpenClawGatewayClientFactory {
  return (options) => {
    observed.options = options;
    return {
      start: () => {
        const notify =
          /* Safe because the production callback ignores HelloOk; this double only reports the handshake transition. */
          options.onHelloOk as (() => void) | undefined;
        notify?.();
      },
      stop: () => undefined,
      stopAndWait: () => Promise.resolve(),
      request: () =>
        Promise.resolve({
          runId: BRIDGE_RUN_ID,
          status: "ok",
          summary: "completed",
          result: {},
        }),
    };
  };
}

function exactBridgeTest() {
  return Effect.gen(function* () {
    const observed: ObservedClient = {};
    const fixture = yield* makeOpenClawContainerFixture();
    const response = yield* Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* fixture.application.attach(
          { host: GATEWAY_HOST, port: GATEWAY_PORT },
          Effect.never,
          unreportedStop,
        );
        return yield* gateway.agent(
          OpenClawGatewayRequest.make({
            message: "Do the task.",
            idempotencyKey: BRIDGE_IDEMPOTENCY_KEY,
          }),
        );
      }),
    ).pipe(Effect.provideService(GatewayOperations, bridgeClient(observed)));

    assert.instanceOf(response, OpenClawGatewaySucceeded);
    assert.strictEqual(response.runId, BRIDGE_RUN_ID);
    assert.strictEqual(
      observed.options?.url,
      `ws://${GATEWAY_HOST}:${String(GATEWAY_PORT)}/`,
    );
    assert.strictEqual(
      observed.options?.token,
      fixture.config.gateway.auth.token,
    );
    assert.match(
      observed.options?.deviceIdentity?.deviceId ?? "",
      /^[\da-f]{64}$/u,
    );
  });
}

describe("OpenClaw container runtime", () => {
  test(
    "renders one OpenClaw application container with credentials confined to bootstrap files",
    applicationContainerTest,
  );
  test(
    "attaches the public OpenClaw gateway and termination observation",
    exactBridgeTest,
  );
  test(
    "threads private evaluation messaging into OpenClaw account configuration",
    privateMessagingModeTest,
  );
});
