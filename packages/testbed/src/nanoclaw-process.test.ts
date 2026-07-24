import { Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { describe, expect, it } from "vitest";

import type { NanoclawRuntimeInstall } from "./nanoclaw-install.js";
import { buildNanoclawProcessPlan } from "./nanoclaw-process.js";

const FIRST_RUNTIME_DIR = "isolated/moltzap-nanoclaw-first";
const SECOND_RUNTIME_DIR = "isolated/moltzap-nanoclaw-second";
const CONFIG_DIRECTORY = ".moltzap";
const EVAL_MODE_ENV = "MOLTZAP_EVAL_MODE";
const LEGACY_DATA_DIR_ENV = "DATA_DIR";

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
        );
        const second = buildNanoclawProcessPlan(
          stubStartOptions("22222222-2222-4222-8222-222222222222"),
          path.resolve(SECOND_RUNTIME_DIR),
          stubInstall(path.resolve("cache/second")),
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
        );
        const enabled = buildNanoclawProcessPlan(
          { ...defaults, autoRegisterConversations: true },
          path.resolve(FIRST_RUNTIME_DIR),
          install,
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
        );
        const secure = buildNanoclawProcessPlan(
          { ...stubStartOptions(), serverUrl: SECURE_SERVER_URL },
          path.resolve(SECOND_RUNTIME_DIR),
          install,
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

function stubStartOptions(
  id = "11111111-1111-4111-8111-111111111111",
  autoRegisterConversations = false,
) {
  return {
    agentName: "nanoclaw-agent",
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
