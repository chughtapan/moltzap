import { Command, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { describe, expect, it } from "vitest";

import type { NanoclawRuntimeInstall } from "./nanoclaw-install.js";
import {
  buildNanoclawContainerListCommand,
  buildNanoclawContainerRemoveCommand,
  buildNanoclawEvalProvisionPlan,
  buildNanoclawProcessPlan,
  nanoclawInstallSlug,
  NANOCLAW_EVAL_AGENT_GROUP_ID,
} from "./nanoclaw-process.js";

const FIRST_RUNTIME_DIR = "isolated/moltzap-nanoclaw-first";
const SECOND_RUNTIME_DIR = "isolated/moltzap-nanoclaw-second";
const CONFIG_DIRECTORY = ".moltzap";
const EVAL_MODE_ENV = "MOLTZAP_EVAL_MODE";
const LEGACY_DATA_DIR_ENV = "DATA_DIR";
const TEST_PATH = "/test/bin:/usr/bin:/bin";
const TEST_HOME = "/test/home";
const TEST_BASE_CHILD_ENVIRONMENT = {
  PATH: TEST_PATH,
  HOME: TEST_HOME,
};
// Every variable a NanoClaw child may see; anything beyond this set leaks
// operator state into the runtime.
const EXPECTED_CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "MOLTZAP_PROFILE",
  "MOLTZAP_CONFIG_HOME",
  "MOLTZAP_SERVER_URL",
  "MOLTZAP_EVAL_MODE",
  "CONTAINER_RUNTIME",
  "CONTAINER_IMAGE",
  "ONECLI_URL",
  "TMPDIR",
  "LOG_LEVEL",
];
const EXPECTED_FIRST_RUNTIME_SLUG = "d3574d3e";
const FIRST_CONTAINER_ID = "0123456789ab";
const SECOND_CONTAINER_ID = "fedcba987654";
const DOCKER_COMMAND = "docker";
const NODE_COMMAND = "node";
const EVAL_PROVISION_ENTRYPOINT = "dist/moltzap-eval-provision.js";
const TEST_AGENT_NAME = "nanoclaw-agent";
const EXPECTED_CONTAINER_LIST_ARGS = [
  "ps",
  "--quiet",
  "--filter",
  `label=nanoclaw-install=${EXPECTED_FIRST_RUNTIME_SLUG}`,
];
const EXPECTED_CONTAINER_REMOVE_ARGS = [
  "rm",
  "--force",
  FIRST_CONTAINER_ID,
  SECOND_CONTAINER_ID,
];

describe("NanoClaw process isolation", () => {
  it(
    "uses an agent-local cwd with an absolute cached entrypoint",
    usesAgentLocalProcessRoot,
  );
  it("derives distinct process roots for distinct agents", isolatesAgents);
  it(
    "keeps unknown-conversation registration opt-in",
    configuresAutoRegistrationExplicitly,
  );
  it(
    "normalizes the ws server url into the runtime env",
    normalizesServerUrlForRuntime,
  );
  it("uses only the explicit child environment", usesExplicitChildEnvironment);
  it(
    "derives the upstream install slug from the runtime directory",
    derivesRuntimeInstallSlug,
  );
  it(
    "scopes Docker cleanup to the runtime install label",
    scopesDockerContainerCleanup,
  );
  it(
    "builds eval provisioning from the immutable install",
    buildsEvalProvisioningPlan,
  );
});

function usesAgentLocalProcessRoot() {
  return runTest(
    Path.Path.pipe(
      Effect.tap((path) => {
        const runtimeDir = path.resolve(FIRST_RUNTIME_DIR);
        const install = stubInstall(path.resolve("cache/nanoclaw"));
        const plan = buildNanoclawProcessPlan(
          stubStartOptions(),
          runtimeDir,
          install,
          TEST_BASE_CHILD_ENVIRONMENT,
        );
        expect(plan.cwd).toBe(runtimeDir);
        expect(path.isAbsolute(plan.args[0] ?? "")).toBe(true);
        expect(plan.args[0]).toBe(path.join(install.cacheDir, "dist/index.js"));
        expect(plan.env.MOLTZAP_CONFIG_HOME).toBe(
          path.join(runtimeDir, CONFIG_DIRECTORY),
        );
        expect(plan.env.CONTAINER_IMAGE).toBe(install.containerImage);
        expect(plan.env).not.toHaveProperty(LEGACY_DATA_DIR_ENV);
      }),
      Effect.asVoid,
      Effect.provide(NodeContext.layer),
    ),
  );
}

function isolatesAgents() {
  return runTest(
    Path.Path.pipe(
      Effect.tap((path) => {
        const first = buildNanoclawProcessPlan(
          stubStartOptions(),
          path.resolve(FIRST_RUNTIME_DIR),
          stubInstall(path.resolve("cache/first")),
          TEST_BASE_CHILD_ENVIRONMENT,
        );
        const second = buildNanoclawProcessPlan(
          stubStartOptions("22222222-2222-4222-8222-222222222222"),
          path.resolve(SECOND_RUNTIME_DIR),
          stubInstall(path.resolve("cache/second")),
          TEST_BASE_CHILD_ENVIRONMENT,
        );

        expect(first.cwd).not.toBe(second.cwd);
        expect(first.env.MOLTZAP_CONFIG_HOME).not.toBe(
          second.env.MOLTZAP_CONFIG_HOME,
        );
      }),
      Effect.asVoid,
      Effect.provide(NodeContext.layer),
    ),
  );
}

function configuresAutoRegistrationExplicitly() {
  return runTest(
    Path.Path.pipe(
      Effect.tap((path) => {
        const runtimeDir = path.resolve(FIRST_RUNTIME_DIR);
        const install = stubInstall(path.resolve("cache/nanoclaw"));
        const defaults = stubStartOptions();
        const disabled = buildNanoclawProcessPlan(
          defaults,
          runtimeDir,
          install,
          TEST_BASE_CHILD_ENVIRONMENT,
        );
        const enabled = buildNanoclawProcessPlan(
          { ...defaults, autoRegisterConversations: true },
          path.resolve(FIRST_RUNTIME_DIR),
          install,
          TEST_BASE_CHILD_ENVIRONMENT,
        );

        expect(disabled.env[EVAL_MODE_ENV]).toBe("0");
        expect(enabled.env[EVAL_MODE_ENV]).toBe("1");
      }),
      Effect.asVoid,
      Effect.provide(NodeContext.layer),
    ),
  );
}

const NORMALIZED_INSECURE_SERVER_URL = "http://localhost:9999";
const SECURE_SERVER_URL = "wss://example.test:8443/ws";
const NORMALIZED_SECURE_SERVER_URL = "https://example.test:8443";

function normalizesServerUrlForRuntime() {
  return runTest(
    Path.Path.pipe(
      Effect.tap((path) => {
        const install = stubInstall(path.resolve("cache/nanoclaw"));
        const insecure = buildNanoclawProcessPlan(
          stubStartOptions(),
          path.resolve(FIRST_RUNTIME_DIR),
          install,
          TEST_BASE_CHILD_ENVIRONMENT,
        );
        const secure = buildNanoclawProcessPlan(
          { ...stubStartOptions(), serverUrl: SECURE_SERVER_URL },
          path.resolve(SECOND_RUNTIME_DIR),
          install,
          TEST_BASE_CHILD_ENVIRONMENT,
        );

        expect(insecure.env.MOLTZAP_SERVER_URL).toBe(
          NORMALIZED_INSECURE_SERVER_URL,
        );
        expect(secure.env.MOLTZAP_SERVER_URL).toBe(
          NORMALIZED_SECURE_SERVER_URL,
        );
      }),
      Effect.asVoid,
      Effect.provide(NodeContext.layer),
    ),
  );
}

function usesExplicitChildEnvironment() {
  return runTest(
    Path.Path.pipe(
      Effect.tap((path) => {
        const runtimeDir = path.resolve(FIRST_RUNTIME_DIR);
        const plan = buildNanoclawProcessPlan(
          stubStartOptions(),
          runtimeDir,
          stubInstall(path.resolve("cache/nanoclaw")),
          TEST_BASE_CHILD_ENVIRONMENT,
        );

        expect(Object.keys(plan.env).sort()).toEqual(
          [...EXPECTED_CHILD_ENV_KEYS].sort(),
        );
        expect(plan.env.PATH).toBe(TEST_PATH);
        expect(plan.env.HOME).toBe(TEST_HOME);
        expect(plan.env.TMPDIR).toBe(path.join(runtimeDir, "tmp"));
      }),
      Effect.asVoid,
      Effect.provide(NodeContext.layer),
    ),
  );
}

function derivesRuntimeInstallSlug() {
  expect(nanoclawInstallSlug(FIRST_RUNTIME_DIR)).toBe(
    EXPECTED_FIRST_RUNTIME_SLUG,
  );
}

function scopesDockerContainerCleanup() {
  const [listCommand] = Command.flatten(
    buildNanoclawContainerListCommand(FIRST_RUNTIME_DIR),
  );
  const [removeCommand] = Command.flatten(
    buildNanoclawContainerRemoveCommand([
      FIRST_CONTAINER_ID,
      SECOND_CONTAINER_ID,
    ]),
  );

  expect(listCommand.command).toBe(DOCKER_COMMAND);
  expect(listCommand.args).toEqual(EXPECTED_CONTAINER_LIST_ARGS);
  expect(removeCommand.command).toBe(DOCKER_COMMAND);
  expect(removeCommand.args).toEqual(EXPECTED_CONTAINER_REMOVE_ARGS);
}

function buildsEvalProvisioningPlan() {
  return runTest(
    Path.Path.pipe(
      Effect.tap((path) => {
        const runtimeDir = path.resolve(FIRST_RUNTIME_DIR);
        const install = stubInstall(path.resolve("cache/nanoclaw"));
        const plan = buildNanoclawEvalProvisionPlan(
          stubStartOptions(undefined, true),
          runtimeDir,
          install,
          TEST_BASE_CHILD_ENVIRONMENT,
        );

        expect(plan.command).toBe(NODE_COMMAND);
        expect(plan.args).toEqual([
          path.join(install.cacheDir, EVAL_PROVISION_ENTRYPOINT),
          NANOCLAW_EVAL_AGENT_GROUP_ID,
          TEST_AGENT_NAME,
          NANOCLAW_EVAL_AGENT_GROUP_ID,
        ]);
        expect(plan.cwd).toBe(runtimeDir);
        expect(Object.keys(plan.env).sort()).toEqual(
          [...EXPECTED_CHILD_ENV_KEYS].sort(),
        );
      }),
      Effect.asVoid,
      Effect.provide(NodeContext.layer),
    ),
  );
}

function stubStartOptions(
  id = "11111111-1111-4111-8111-111111111111",
  autoRegisterConversations = false,
) {
  return {
    agentName: TEST_AGENT_NAME,
    agentId: agentId(id),
    apiKey: redactedAgentKey(agentKeyString(91)),
    serverUrl: "ws://localhost:9999/ws",
    autoRegisterConversations,
  };
}

function stubInstall(cacheDir: string): NanoclawRuntimeInstall {
  return {
    cacheDir,
    cacheFingerprint: "a".repeat(64),
    containerImage: "nanoclaw-agent:moltzap-" + "a".repeat(64),
  };
}

function runTest<A, E>(effect: Effect.Effect<A, E, never>) {
  return Effect.runPromise(effect);
}
