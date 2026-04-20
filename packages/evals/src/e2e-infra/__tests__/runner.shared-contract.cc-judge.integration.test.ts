import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { TIER5_SCENARIOS } from "../scenarios.js";
import { telemetry } from "../telemetry.js";
import { deriveJudgmentRunId } from "../judgment-bundle.js";

const ccJudgeRoot = "/home/tapanc/cc-judge-build";
const require = createRequire(import.meta.url);
const agentModelId =
  process.env["MOLTZAP_E2E_AGENT_MODEL"] ??
  "anthropic/claude-sonnet-4-20250514";

afterEach(() => {
  telemetry.reset();
});

async function loadCcJudge() {
  const ccJudgeDistUrl = pathToFileURL(
    path.join(ccJudgeRoot, "dist/index.js"),
  ).href;
  const effectUrl = pathToFileURL(
    require.resolve("effect", { paths: [ccJudgeRoot] }),
  ).href;
  const [ccJudge, ccJudgeEffect] = await Promise.all([
    import(ccJudgeDistUrl),
    import(effectUrl),
  ]);
  return {
    bundleAutoCodec: ccJudge.bundleAutoCodec,
    scoreBundles: ccJudge.scoreBundles,
    Effect: ccJudgeEffect.Effect as typeof Effect,
  };
}

function messageTexts(
  bundle: ReadonlyArray<{ type: string; text?: string }>,
): string[] {
  return bundle
    .filter(
      (event): event is { type: "message"; text: string } =>
        event.type === "message" && typeof event.text === "string",
    )
    .map((event) => event.text);
}

describe("runE2EEvals shared contract against actual cc-judge", () => {
  it(
    "runs openclaw end to end and scores the emitted bundle with cc-judge",
    { timeout: 300_000 },
    async () => {
      const { bundleAutoCodec, scoreBundles, Effect: ccJudgeEffect } =
        await loadCcJudge();
      const { runE2EEvals } = await import("../runner.js");

      const scenario = TIER5_SCENARIOS.find((entry) => entry.id === "EVAL-018");
      expect(scenario).toBeDefined();
      if (scenario === undefined) {
        return;
      }

      const outputDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "moltzap-runner-"),
      );
      const result = await Effect.runPromise(
        runE2EEvals({
          scenarios: [scenario.id],
          agentModelId,
          runtime: "openclaw",
          resultsDir: outputDir,
          cleanResults: true,
        }),
      );

      const runId = deriveJudgmentRunId({
        scenarioId: scenario.id,
        runNumber: 1,
        modelName: agentModelId,
      });
      const bundleDir = path.join(outputDir, "bundles");
      const bundleJsonPath = path.join(bundleDir, `${runId}.json`);
      const bundleYamlPath = path.join(bundleDir, `${runId}.yaml`);
      expect(fs.existsSync(bundleJsonPath)).toBe(true);
      expect(fs.existsSync(bundleYamlPath)).toBe(true);
      expect(result.summary.total).toBe(1);
      expect(result.results).toHaveLength(1);

      const bundleSource = fs.readFileSync(bundleYamlPath, "utf8");
      const bundle = (await ccJudgeEffect.runPromise(
        bundleAutoCodec.decode(bundleSource, bundleYamlPath),
      )) as {
        events?: ReadonlyArray<{ type: string; text?: string }>;
      };
      const observedMessageTexts = messageTexts(bundle.events ?? []);
      const emittedResponse = result.results[0]?.agentResponse ?? "";

      expect(emittedResponse.trim().length).toBeGreaterThan(0);
      expect(observedMessageTexts).toContain(scenario.setupMessage);
      expect(observedMessageTexts).toContain(emittedResponse);

      const judgeBackend = {
        name: "content-preserving-bundle-check",
        judge(input: any) {
          const texts = messageTexts(input.events ?? []);
          const pass =
            texts.includes(scenario.setupMessage) &&
            texts.includes(emittedResponse) &&
            texts.every((text) => text.trim().length > 0);
          return ccJudgeEffect.succeed({
            pass,
            reason: pass
              ? "message content preserved"
              : `missing message content: ${texts.join(" | ")}`,
            issues: pass
              ? []
              : [
                  {
                    issue: "message content was lost in bundle conversion",
                    severity: "critical" as const,
                  },
                ],
            overallSeverity: pass ? null : ("critical" as const),
            retryCount: 0,
          });
        },
      };

      const report = (await ccJudgeEffect.runPromise(
        scoreBundles([bundle], {
          judge: judgeBackend,
          resultsDir: path.join(outputDir, "cc-judge-results"),
        }),
      )) as {
        summary: { total: number; passed: number };
        runs: Array<{ pass: boolean; source: string }>;
      };

      expect(report.summary.total).toBe(1);
      expect(report.summary.passed).toBe(1);
      expect(report.runs[0]?.pass).toBe(true);
      expect(report.runs[0]?.source).toBe("bundle");
    },
  );
});
