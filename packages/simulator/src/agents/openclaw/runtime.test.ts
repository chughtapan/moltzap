/** @file OpenClaw container rendering, bootstrap isolation, and gateway attachment regressions. */

import { assert, it as effectIt } from "@effect/vitest";
import { AgentName } from "@moltzap/identity";
import { Effect, Schema } from "effect";
import { describe } from "vitest";
import {
  AgentRuntimeDefinitionError,
  type RuntimeAcquisitionError,
  runtimeConfigurationProjection,
} from "../agent.js";
import {
  type Application,
  type ContainerRuntime,
  containerRuntimeFor,
  CREDENTIALS,
  type File,
  image,
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
const APPLICATION_IMAGE = image.make(
  "example.invalid/openclaw-agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const BOOTSTRAP_ROOT = "/var/run/moltzap/bootstrap/";
const OPENCLAW_EXTENSION_PATH =
  "/opt/moltzap/node_modules/@moltzap/openclaw-channel";
const WORKSPACE_PATH = `${BOOTSTRAP_ROOT}workspace/IDENTITY.md`;
const GATEWAY_PORT = 18_789;
const APPLICATION_STATE_DIR = `${BOOTSTRAP_ROOT}state`;
const OPENCLAW_CONFIG_PATH = `${APPLICATION_STATE_DIR}/openclaw.json`;
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
            mode: Schema.Literal("shared", "private"),
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
      visibleReplies: Schema.Literal("message_tool"),
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
      applicationImage: APPLICATION_IMAGE,
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
  assert.strictEqual(capability.image, APPLICATION_IMAGE);
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
    cpuMillis: 1_100,
    memoryBytes: 1_280 * 1_024 * 1_024,
    ephemeralStorageBytes: 1_024 * 1_024 * 1_024,
  });
  assert.deepStrictEqual(application.entrypoint, [
    "node",
    "/opt/moltzap/agent/entrypoint.mjs",
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
  assert.deepStrictEqual(application.credentials, [
    "OPENAI_API_KEY",
    "CODEX_AUTH_JSON",
  ]);
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
    { id: "simulator-agent", mode: "shared" },
  ]);
  assert.deepStrictEqual(config.messages, {
    queue: { mode: "steer", cap: 100, drop: "new" },
    inbound: { debounceMs: 0 },
    visibleReplies: "message_tool",
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
    const runtime = openClawRuntime({
      applicationImage: APPLICATION_IMAGE,
      messagingMode: "private",
    });
    const capability = containerRuntimeFor(runtime);
    const application = yield* capability.render({ agentName: AGENT_NAME });
    const config = Schema.decodeUnknownSync(renderedOpenClawConfig)(
      requireFile(application.files, OPENCLAW_CONFIG_PATH),
    );

    assert.deepStrictEqual(config.channels.moltzap.accounts, [
      { id: "simulator-agent", mode: "private" },
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

const harvestProjection = Schema.Struct({
  harvestWorkspaceFiles: Schema.Array(Schema.String),
});

function renderHarvest(harvestWorkspaceFiles?: readonly string[]) {
  const runtime = openClawRuntime({
    applicationImage: APPLICATION_IMAGE,
    ...(harvestWorkspaceFiles === undefined ? {} : { harvestWorkspaceFiles }),
  });
  return containerRuntimeFor(runtime)
    .render({ agentName: AGENT_NAME })
    .pipe(Effect.map((application) => ({ runtime, application })));
}

function harvestTargetsTest() {
  return Effect.gen(function* () {
    const { runtime, application } = yield* renderHarvest([
      "CALENDAR.md",
      "./notes/log.md",
    ]);

    assert.deepStrictEqual(application.harvest, [
      {
        relativePath: "CALENDAR.md",
        path: `${BOOTSTRAP_ROOT}workspace/CALENDAR.md`,
        limitBytes: 65_536,
      },
      {
        relativePath: "notes/log.md",
        path: `${BOOTSTRAP_ROOT}workspace/notes/log.md`,
        limitBytes: 65_536,
      },
    ]);
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(harvestProjection)(
        runtimeConfigurationProjection(runtime),
      ).harvestWorkspaceFiles,
      ["CALENDAR.md", "notes/log.md"],
    );
  });
}

function noHarvestTest() {
  return Effect.gen(function* () {
    const { runtime, application } = yield* renderHarvest();

    assert.notProperty(application, "harvest");
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(harvestProjection)(
        runtimeConfigurationProjection(runtime),
      ).harvestWorkspaceFiles,
      [],
    );
  });
}

function rejectedHarvestPathTest(): void {
  assert.throws(() =>
    openClawRuntime({
      applicationImage: APPLICATION_IMAGE,
      harvestWorkspaceFiles: ["../secrets.md"],
    }),
  );
}

describe("OpenClaw workspace harvest", () => {
  test(
    "renders each declared file under the OpenClaw workspace and records the names",
    harvestTargetsTest,
  );
  test("declares no harvest when the experiment names no files", noHarvestTest);
  test("refuses a harvest path that leaves the workspace", () =>
    Effect.sync(rejectedHarvestPathTest));
});

const historyExportProjection = Schema.Struct({
  historyExport: Schema.Boolean,
});

function historyExportTest() {
  return Effect.gen(function* () {
    const runtime = openClawRuntime({
      applicationImage: APPLICATION_IMAGE,
      harvestWorkspaceFiles: ["CALENDAR.md"],
      historyExport: true,
    });
    const application = yield* containerRuntimeFor(runtime).render({
      agentName: AGENT_NAME,
    });

    assert.strictEqual(
      application.environment.MOLTZAPD_HISTORY_EXPORT,
      "/var/run/moltzap/history.ndjson",
    );
    assert.deepStrictEqual(application.harvest?.at(-1), {
      relativePath: "moltzap-history.ndjson",
      path: "/var/run/moltzap/history.ndjson",
      limitBytes: 1_048_576,
    });
    assert.strictEqual(application.harvest?.length, 2);
    assert.isTrue(
      Schema.decodeUnknownSync(historyExportProjection)(
        runtimeConfigurationProjection(runtime),
      ).historyExport,
    );
  });
}

function noHistoryExportTest() {
  return Effect.gen(function* () {
    const { runtime, application } = yield* renderHarvest();

    assert.notProperty(application.environment, "MOLTZAPD_HISTORY_EXPORT");
    assert.notProperty(application, "harvest");
    assert.isFalse(
      Schema.decodeUnknownSync(historyExportProjection)(
        runtimeConfigurationProjection(runtime),
      ).historyExport,
    );
  });
}

describe("OpenClaw history export", () => {
  test(
    "turns the daemon export on and harvests it beside the experiment's files",
    historyExportTest,
  );
  test("leaves the daemon export off by default", noHistoryExportTest);
});

const modelUsageProjection = Schema.Struct({
  modelUsage: Schema.optional(Schema.Boolean),
});

function renderModelUsage() {
  const runtime = openClawRuntime({
    applicationImage: APPLICATION_IMAGE,
    modelUsage: true,
  });
  return Effect.map(
    containerRuntimeFor(runtime).render({ agentName: AGENT_NAME }),
    (application) => ({ runtime, application }),
  );
}

function modelUsageEnvironmentTest() {
  return Effect.gen(function* () {
    const { application } = yield* renderModelUsage();

    assert.strictEqual(
      application.environment.MOLTZAP_AGENT_IMAGE_MODEL_USAGE,
      "/var/run/moltzap/model-usage.json",
    );
  });
}

function modelUsageHarvestTest() {
  return Effect.gen(function* () {
    const { application } = yield* renderModelUsage();

    assert.deepStrictEqual(application.harvest, [
      {
        relativePath: "moltzap-model-usage.json",
        path: "/var/run/moltzap/model-usage.json",
        limitBytes: 1_048_576,
      },
    ]);
  });
}

function modelUsageRetainedTest() {
  return Effect.gen(function* () {
    const { application } = yield* renderModelUsage();

    assert.include(
      (application.logs ?? []).map((log) => log.relativePath),
      "moltzap-model-usage.json",
    );
  });
}

function modelUsageRecordedTest() {
  return Effect.gen(function* () {
    const { runtime } = yield* renderModelUsage();

    assert.isTrue(
      Schema.decodeUnknownSync(modelUsageProjection)(
        runtimeConfigurationProjection(runtime),
      ).modelUsage,
    );
  });
}

function noModelUsageTest() {
  return Effect.gen(function* () {
    const { runtime, application } = yield* renderHarvest();

    assert.notProperty(
      application.environment,
      "MOLTZAP_AGENT_IMAGE_MODEL_USAGE",
    );
    assert.notProperty(runtimeConfigurationProjection(runtime), "modelUsage");
  });
}

describe("OpenClaw model usage", () => {
  test(
    "tells the agent image where to write the summary",
    modelUsageEnvironmentTest,
  );
  test("harvests the summary under its reserved label", modelUsageHarvestTest);
  test(
    "retains the whole summary beside the native logs",
    modelUsageRetainedTest,
  );
  test(
    "records the setting in the runtime configuration",
    modelUsageRecordedTest,
  );
  test("asks for no summary by default and records nothing", noModelUsageTest);
});

function renderWithModel(modelId?: string) {
  return containerRuntimeFor(
    openClawRuntime({
      applicationImage: APPLICATION_IMAGE,
      ...(modelId === undefined ? {} : { modelId }),
    }),
  ).render({ agentName: AGENT_NAME });
}

/**
 * The cluster writes a file credential at `HOME` plus the table's relative
 * path, under the same bootstrap rules as every rendered file: below the
 * bootstrap root, and at a path no other file already owns.
 */
function assertHomeAcceptsFileCredentials(
  application: OpenClawContainerFixture["application"],
): void {
  const home = application.environment.HOME;
  assert.isDefined(home);
  assert.isTrue(home.startsWith(BOOTSTRAP_ROOT));
  assert.isFalse(home.endsWith("/"));
  const rendered = application.files.map((file) => file.path);
  const targets = fileCredentialTargets(home);
  assert.isNotEmpty(targets);
  for (const target of targets) {
    assert.notInclude(rendered, target);
  }
}

function fileCredentialTargets(home: string): readonly string[] {
  return Object.values(CREDENTIALS).flatMap((delivery) =>
    delivery.delivery === "file"
      ? [`${home}/${delivery.homeRelativePath}`]
      : [],
  );
}

describe("OpenClaw provider credentials", () => {
  /**
   * Both OpenAI harnesses accept an API key or a Codex login; the cohort
   * forwards whichever the run holds and refuses a run holding both.
   */
  test("requests the credentials the model's provider prefix names, and none without a model", () =>
    Effect.gen(function* () {
      const anthropic = yield* renderWithModel("anthropic/claude-sonnet-4");
      const openai = yield* renderWithModel("openai/gpt-5.5");
      const other = yield* renderWithModel("google/gemini-2");
      const unnamed = yield* renderWithModel();

      assert.deepStrictEqual(anthropic.credentials, ["ANTHROPIC_API_KEY"]);
      assert.deepStrictEqual(openai.credentials, [
        "OPENAI_API_KEY",
        "CODEX_AUTH_JSON",
      ]);
      assert.notProperty(other, "credentials");
      assert.notProperty(unnamed, "credentials");
    }));

  test("declares a HOME a file-delivered credential can land in, for the Codex app-server and Claude Code alike", () =>
    Effect.gen(function* () {
      assertHomeAcceptsFileCredentials(
        yield* renderWithModel("openai/gpt-5.6-sol"),
      );
      const { application } = yield* renderClaudeCode();
      assertHomeAcceptsFileCredentials(application);
    }));
});

const SECRETS_PLAN_PATH = `${BOOTSTRAP_ROOT}secrets-plan.json`;
const CLAUDE_MODEL_ID = "anthropic/claude-opus-4-8";
const agentRuntimeProjection = Schema.Struct({
  agentRuntime: Schema.optional(Schema.Literal("claude-cli")),
});
const renderedSecretsPlan = Schema.parseJson(
  Schema.Struct({
    version: Schema.Literal(1),
    protocolVersion: Schema.Literal(1),
    targets: Schema.Tuple(
      Schema.Struct({
        type: Schema.Literal("auth-profiles.token.token"),
        path: Schema.String,
        agentId: Schema.String,
        authProfileProvider: Schema.Literal("anthropic"),
        ref: Schema.Struct({
          source: Schema.Literal("env"),
          provider: Schema.Literal("default"),
          id: Schema.Literal("CLAUDE_CODE_OAUTH_TOKEN"),
        }),
      }),
    ),
  }),
);
const renderedHarnessConfig = Schema.parseJson(
  Schema.Struct({
    auth: Schema.optional(
      Schema.Struct({
        profiles: Schema.Record({
          key: Schema.String,
          value: Schema.Struct({
            provider: Schema.String,
            mode: Schema.String,
          }),
        }),
        order: Schema.Record({
          key: Schema.String,
          value: Schema.Array(Schema.String),
        }),
      }),
    ),
    agents: Schema.Struct({
      defaults: Schema.Struct({
        models: Schema.optional(
          Schema.Record({
            key: Schema.String,
            value: Schema.Struct({
              agentRuntime: Schema.Struct({ id: Schema.String }),
            }),
          }),
        ),
      }),
    }),
  }),
);

function fileAt(files: readonly File[], path: string): File | undefined {
  return files.find((file) => file.path === path);
}

/**
 * Experiment modules are untyped `.mjs`, so a harness name the option's type
 * forbids still reaches the constructor, exactly as this call delivers it.
 */
function definesUntypedHarness(agentRuntime: string): void {
  Reflect.apply(openClawRuntime, undefined, [
    {
      applicationImage: APPLICATION_IMAGE,
      modelId: CLAUDE_MODEL_ID,
      agentRuntime,
    },
  ]);
}

function rejectsUntypedHarness(agentRuntime: string): void {
  assert.throws(() => {
    definesUntypedHarness(agentRuntime);
  });
}

function rejectsClaudeCodeFor(modelId?: string): void {
  assert.throws(
    () =>
      openClawRuntime({
        applicationImage: APPLICATION_IMAGE,
        agentRuntime: "claude-cli",
        ...(modelId === undefined ? {} : { modelId }),
      }),
    AgentRuntimeDefinitionError,
  );
}

function renderClaudeCode() {
  const runtime = openClawRuntime({
    applicationImage: APPLICATION_IMAGE,
    modelId: CLAUDE_MODEL_ID,
    agentRuntime: "claude-cli",
  });
  return Effect.map(
    containerRuntimeFor(runtime).render({ agentName: AGENT_NAME }),
    (application) => ({ runtime, application }),
  );
}

describe("OpenClaw Claude Code runtime", () => {
  test("asks for the subscription token and binds it through a secret-free plan", () =>
    Effect.gen(function* () {
      const { runtime, application } = yield* renderClaudeCode();

      assert.deepStrictEqual(application.credentials, [
        "CLAUDE_CODE_OAUTH_TOKEN",
      ]);
      assert.strictEqual(
        application.environment.OPENCLAW_SECRETS_PLAN,
        SECRETS_PLAN_PATH,
      );
      assert.strictEqual(application.environment.DISABLE_AUTOUPDATER, "1");
      assert.strictEqual(
        application.environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
        "1",
      );

      const plan = Schema.decodeUnknownSync(renderedSecretsPlan, {
        onExcessProperty: "error",
      })(requireFile(application.files, SECRETS_PLAN_PATH));
      assert.strictEqual(plan.targets[0].agentId, AGENT_NAME);
      assert.strictEqual(
        plan.targets[0].path,
        "profiles.anthropic:default.token",
      );

      const config = Schema.decodeUnknownSync(renderedHarnessConfig)(
        requireFile(application.files, OPENCLAW_CONFIG_PATH),
      );
      assert.deepStrictEqual(config.auth, {
        profiles: {
          "anthropic:default": { provider: "anthropic", mode: "token" },
        },
        order: { anthropic: ["anthropic:default"] },
      });
      assert.deepStrictEqual(config.agents.defaults.models, {
        [CLAUDE_MODEL_ID]: { agentRuntime: { id: "claude-cli" } },
      });
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(agentRuntimeProjection)(
          runtimeConfigurationProjection(runtime),
        ),
        { agentRuntime: "claude-cli" },
      );
    }));
});

describe("OpenClaw embedded runtime without Claude Code", () => {
  test("leaves an embedded-runtime render without any Claude Code material", () =>
    Effect.gen(function* () {
      const fixture = yield* makeOpenClawContainerFixture();

      assert.notProperty(
        fixture.application.environment,
        "OPENCLAW_SECRETS_PLAN",
      );
      assert.isUndefined(fileAt(fixture.application.files, SECRETS_PLAN_PATH));
      const config = Schema.decodeUnknownSync(renderedHarnessConfig)(
        requireFile(fixture.application.files, OPENCLAW_CONFIG_PATH),
      );
      assert.isUndefined(config.auth);
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(agentRuntimeProjection)(
          runtimeConfigurationProjection(fixture.runtime),
        ),
        {},
      );
    }));

  test("refuses Claude Code for any model that is not Anthropic's, including the default and a prefix in the wrong case", () =>
    Effect.sync(() => {
      rejectsClaudeCodeFor("openai/gpt-5.6-sol");
      rejectsClaudeCodeFor("Anthropic/claude-opus-4-8");
      rejectsClaudeCodeFor();
    }));

  test("refuses a harness name it does not know when the runtime is defined", () =>
    Effect.sync(() => {
      for (const agentRuntime of ["claude", "codex", ""]) {
        rejectsUntypedHarness(agentRuntime);
      }
      definesUntypedHarness("claude-cli");
    }));
});
