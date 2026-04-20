import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIER5_SCENARIOS } from "../scenarios.js";
import { telemetry } from "../telemetry.js";
import { deriveJudgmentRunId } from "../judgment-bundle.js";

afterEach(() => {
  telemetry.reset();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("runE2EEvals shared contract", () => {
  it(
    "emits bundles through the shared-contract path for nanoclaw by default",
    { timeout: 30_000 },
    async () => {
      const serverCore = await import("@moltzap/server-core/test-utils");
      const client = await import("@moltzap/client");
      const clientTest = await import("@moltzap/client/test");
      const evalRuntime = await import("../eval-runtime.js");

      const runtimeSession = {
        name: "eval-target-agent",
        waitUntilReady: vi.fn().mockReturnValue(Effect.succeed({ _tag: "Ready" })),
        teardown: vi.fn().mockReturnValue(Effect.succeed(undefined)),
        getLogs: vi.fn().mockReturnValue({ text: "", nextOffset: 0 }),
        getInboundMarker: vi.fn().mockReturnValue("inbound from agent:"),
      };

      vi.spyOn(serverCore, "startCoreTestServer").mockResolvedValue({
        baseUrl: "http://core.test",
        wsUrl: "ws://core.test/ws",
        coreApp: {},
      } as never);
      vi.spyOn(serverCore, "stopCoreTestServer").mockResolvedValue(undefined);
      vi.spyOn(serverCore, "resetCoreTestDb").mockResolvedValue(undefined);
      vi.spyOn(evalRuntime, "launchEvalRuntime").mockReturnValue(
        Effect.succeed(runtimeSession as never),
      );
      vi.spyOn(clientTest, "registerAgent").mockImplementation((_, name) =>
        Effect.succeed({
          agentId: `${name}-id`,
          apiKey: `${name}-key`,
          claimUrl: "http://claim.test",
          claimToken: `${name}-claim-token`,
        } as never),
      );
      vi.spyOn(clientTest, "stripWsPath").mockImplementation((url) => url);
      vi.spyOn(client.MoltZapWsClient.prototype, "connect").mockReturnValue(
        Effect.succeed(undefined),
      );
      vi.spyOn(client.MoltZapWsClient.prototype, "drainEvents").mockReturnValue(
        [],
      );

      const { runE2EEvals } = await import("../runner.js");

      const outputDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "moltzap-runner-"),
      );
      const scenario = TIER5_SCENARIOS.find((entry) => entry.id === "EVAL-018");
      expect(scenario).toBeDefined();

      const result = await Effect.runPromise(
        runE2EEvals({
          scenarios: ["EVAL-018"],
          agentModelId: "openclaw-eval",
          runtime: "nanoclaw",
          resultsDir: outputDir,
          cleanResults: true,
          signal: AbortSignal.abort(),
        }),
      );

      const runId = deriveJudgmentRunId({
        scenarioId: "EVAL-018",
        runNumber: 1,
        modelName: "openclaw-eval",
      });
      const bundleDir = path.join(outputDir, "bundles");
      const bundleJsonPath = path.join(bundleDir, `${runId}.json`);
      const bundleYamlPath = path.join(bundleDir, `${runId}.yaml`);
      const summaryPath = path.join(outputDir, "summary.md");
      const bundle = JSON.parse(fs.readFileSync(bundleJsonPath, "utf8")) as {
        events: Array<{ type: string }>;
      };

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(0);
      expect(result.summary.failed).toBe(1);
      expect(fs.existsSync(bundleJsonPath)).toBe(true);
      expect(fs.existsSync(bundleYamlPath)).toBe(true);
      expect(fs.existsSync(summaryPath)).toBe(false);
      expect(bundle.events.map((event) => event.type)).toEqual(["phase"]);
      expect(serverCore.startCoreTestServer).toHaveBeenCalledTimes(1);
      expect(evalRuntime.launchEvalRuntime).toHaveBeenCalledTimes(1);
      expect(runtimeSession.waitUntilReady).toHaveBeenCalledTimes(1);
      expect(runtimeSession.teardown).toHaveBeenCalledTimes(1);
      expect(clientTest.registerAgent).toHaveBeenCalledTimes(3);
    },
  );
});
