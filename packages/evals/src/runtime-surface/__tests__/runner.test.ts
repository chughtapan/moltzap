import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runEvalCatalog } from "../runner.js";

function writeScenarioDoc(dir: string, filename: string): string {
  const target = path.join(dir, filename);
  fs.writeFileSync(
    target,
    stringifyYaml({
      id: "EVAL-950",
      name: "Runtime surface scenario",
      description: "Runtime surface smoke test",
      runtime: "openclaw",
      conversation: {
        _tag: "DirectMessage",
        setupMessage: "hello",
        followUpMessages: ["what changed?"],
      },
      expectedBehavior: "Reply coherently",
      assertions: [{ _tag: "ContainsText", text: "hello" }],
    }),
  );
  return target;
}

function fakeDeps() {
  const logger = { info: vi.fn() };
  const runtimeConfig = {
    configPath: "moltzap.yaml",
  };
  return {
    runtimeConfig: runtimeConfig as never,
    observability: {
      logger,
      config: runtimeConfig,
      annotate: <A, E, R>(
        _context: unknown,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => effect,
      span: <A, E, R>(
        _span: unknown,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => effect,
    } as never,
    logger,
  };
}

describe("runtime-surface runner", () => {
  it("stages a catalog and resolves cc-judge as the default mode", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-runner-"));
    const scenarioPath = writeScenarioDoc(tempDir, "scenario.yaml");
    const deps = fakeDeps();

    const receipt = await Effect.runPromise(
      runEvalCatalog(deps, {
        scenarioDocuments: [scenarioPath as never],
        runtime: "openclaw",
        resultsDirectory: tempDir as never,
        retainArtifacts: true,
      }),
    );

    expect(receipt.executionMode._tag).toBe("CcJudgeDefault");
    expect(receipt.stagedHarness.artifacts).toHaveLength(1);
    expect(
      fs.existsSync(receipt.stagedHarness.artifacts[0]!.plannedHarnessPath),
    ).toBe(true);
    expect(deps.logger.info).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy path behind explicit opt-in", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-runner-"));
    const scenarioPath = writeScenarioDoc(tempDir, "scenario.yaml");

    const receipt = await Effect.runPromise(
      runEvalCatalog(fakeDeps(), {
        scenarioDocuments: [scenarioPath as never],
        runtime: "openclaw",
        resultsDirectory: tempDir as never,
        retainArtifacts: true,
        requestedMode: "legacy-llm-judge",
      }),
    );

    expect(receipt.executionMode).toEqual({
      _tag: "LegacyLlmJudgeExplicit",
      requestedBy: "cli-flag",
      surface: "llm-judge",
    });
  });
});
