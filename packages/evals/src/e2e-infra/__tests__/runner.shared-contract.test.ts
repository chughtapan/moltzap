import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIER5_SCENARIOS } from "../scenarios.js";
import { telemetry } from "../telemetry.js";

afterEach(() => {
  telemetry.reset();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("runE2EEvals shared contract", () => {
  it(
    "emits bundles and skips the legacy judge path",
    { timeout: 30_000 },
    async () => {
      const serverCore = await import("@moltzap/server-core/test-utils");
      const client = await import("@moltzap/client");
      const clientTest = await import("@moltzap/client/test");
      const evalRuntime = await import("../eval-runtime.js");
      const judge = await import("../llm-judge.js");
      const report = await import("../report.js");
      const sharedContract = await import("../shared-contract-evaluation.js");

      vi.spyOn(serverCore, "startCoreTestServer").mockResolvedValue({
        baseUrl: "http://core.test",
        wsUrl: "ws://core.test/ws",
      } as never);
      vi.spyOn(serverCore, "stopCoreTestServer").mockResolvedValue(undefined);
      vi.spyOn(serverCore, "resetCoreTestDb").mockResolvedValue(undefined);
      vi.spyOn(evalRuntime, "launchEvalRuntime").mockReturnValue(
        Effect.succeed({
          name: "eval-target-agent",
          waitUntilReady: () => Effect.succeed({ _tag: "Ready" as const }),
          teardown: () => Effect.succeed(undefined),
          getLogs: () => ({ text: "", nextOffset: 0 }),
          getInboundMarker: () => "inbound from agent:",
        }),
      );
      vi.spyOn(sharedContract, "runSharedContractEvaluation").mockReturnValue(
        Effect.succeed({
          result: {
            results: [],
            summary: {
              total: 1,
              passed: 1,
              failed: 0,
              avgLatencyMs: 0,
            },
          },
        }) as never,
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
      vi.spyOn(judge, "judgeAgentResponse").mockImplementation(() => {
        throw new Error(
          "judgeAgentResponse should not be called in shared mode",
        );
      });
      vi.spyOn(judge, "analyzeFailures").mockImplementation(() => {
        throw new Error("analyzeFailures should not be called in shared mode");
      });
      vi.spyOn(report, "generateReport").mockImplementation(() => {
        throw new Error("generateReport should not be called in shared mode");
      });
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
          runtime: "openclaw",
          resultsDir: outputDir,
          cleanResults: true,
          signal: AbortSignal.abort(),
        }),
      );

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(1);
      expect(result.summary.failed).toBe(0);
      expect(judge.judgeAgentResponse).not.toHaveBeenCalled();
      expect(judge.analyzeFailures).not.toHaveBeenCalled();
      expect(report.generateReport).not.toHaveBeenCalled();
      expect(serverCore.startCoreTestServer).toHaveBeenCalledTimes(1);
      expect(evalRuntime.launchEvalRuntime).toHaveBeenCalledTimes(1);
      expect(sharedContract.runSharedContractEvaluation).toHaveBeenCalledTimes(
        1,
      );
      expect(clientTest.registerAgent).toHaveBeenCalledTimes(3);
    },
  );
});
