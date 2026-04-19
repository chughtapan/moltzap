import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIER5_SCENARIOS } from "../scenarios.js";
import { telemetry } from "../telemetry.js";
import { deriveJudgmentRunId } from "../judgment-bundle.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);
const require = createRequire(import.meta.url);
const effectEntryUrl = pathToFileURL(require.resolve("effect")).href;

afterEach(() => {
  telemetry.reset();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function verifyBundleWithCcJudge(
  bundleJsonPath: string,
  bundleYamlPath: string,
  runId: string,
): Promise<void> {
  const ccJudgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-judge-"));
  execFileSync("git", [
    "clone",
    "--depth",
    "1",
    "--quiet",
    "https://github.com/chughtapan/cc-judge.git",
    ccJudgeDir,
  ]);

  const effectPackageDir = path.resolve(
    path.dirname(require.resolve("effect")),
    "..",
    "..",
  );
  const effectUrl = pathToFileURL(
    path.join(effectPackageDir, "dist/esm/index.js"),
  ).href;
  const typeboxPackageDir = path.resolve(
    path.dirname(require.resolve("@sinclair/typebox")),
    "..",
    "..",
  );
  const typeboxUrl = pathToFileURL(
    path.join(typeboxPackageDir, "build/esm/index.mjs"),
  ).href;
  const typeboxValueUrl = pathToFileURL(
    path.join(typeboxPackageDir, "build/esm/value/index.mjs"),
  ).href;
  const yamlUrl = pathToFileURL(require.resolve("yaml")).href;

  const patchFile = (
    relativePath: string,
    replacements: Array<[string, string]>,
  ): void => {
    const filePath = path.join(ccJudgeDir, relativePath);
    let source = fs.readFileSync(filePath, "utf8");
    for (const [from, to] of replacements) {
      source = source.replace(from, to);
    }
    fs.writeFileSync(filePath, source);
  };

  patchFile("src/core/types.ts", [
    [
      'import { Brand } from "effect";',
      `import { Brand } from "${effectUrl}";`,
    ],
  ]);
  patchFile("src/core/errors.ts", [
    ['import { Data } from "effect";', `import { Data } from "${effectUrl}";`],
  ]);
  patchFile("src/core/schema.ts", [
    [
      'import { Type, type Static, type TSchema } from "@sinclair/typebox";',
      `import { Type } from "${typeboxUrl}";`,
    ],
  ]);
  patchFile("src/emit/bundle-codec.ts", [
    [
      'import { Effect } from "effect";',
      `import { Effect } from "${effectUrl}";`,
    ],
    [
      'import { Value } from "@sinclair/typebox/value";',
      `import { Value } from "${typeboxValueUrl}";`,
    ],
    ['import * as YAML from "yaml";', `import * as YAML from "${yamlUrl}";`],
  ]);

  const scriptPath = path.join(ccJudgeDir, "verify-bundle.ts");
  fs.writeFileSync(
    scriptPath,
    `import { readFileSync } from "node:fs";
import { Effect } from "${effectEntryUrl}";
import { bundleAutoCodec } from "${pathToFileURL(path.join(ccJudgeDir, "src/emit/bundle-codec.ts")).href}";

const [jsonPath, yamlPath, expectedRunId] = process.argv.slice(2);
if (!jsonPath || !yamlPath || !expectedRunId) {
  throw new Error("expected json path, yaml path, and run id");
}

for (const sourcePath of [jsonPath, yamlPath]) {
  const decoded = await Effect.runPromise(
    bundleAutoCodec.decode(readFileSync(sourcePath, "utf8"), sourcePath),
  );
  if (decoded.runId !== expectedRunId) {
    throw new Error(\`unexpected runId: \${decoded.runId}\`);
  }
  if (decoded.project !== "moltzap") {
    throw new Error(\`unexpected project: \${decoded.project}\`);
  }
  if (decoded.outcomes.length !== 1) {
    throw new Error(\`unexpected outcomes length: \${decoded.outcomes.length}\`);
  }
  if (decoded.metadata?.contractMode !== "shared") {
    throw new Error("missing shared contract metadata");
  }
}

console.log("cc-judge bundle decode ok");
`,
  );

  execFileSync(
    "pnpm",
    [
      "--filter",
      "@moltzap/evals",
      "exec",
      "tsx",
      scriptPath,
      bundleJsonPath,
      bundleYamlPath,
      runId,
    ],
    {
      cwd: repoRoot,
      stdio: "pipe",
    },
  );
}

describe("runE2EEvals shared contract against actual cc-judge", () => {
  it(
    "emits bundles that cc-judge can decode",
    { timeout: 180_000 },
    async () => {
      const serverCore = await import("@moltzap/server-core/test-utils");
      const client = await import("@moltzap/client");
      const clientTest = await import("@moltzap/client/test");
      const agentFleet = await import("../agent-fleet.js");
      const judge = await import("../llm-judge.js");
      const report = await import("../report.js");

      vi.spyOn(serverCore, "startCoreTestServer").mockResolvedValue({
        baseUrl: "http://core.test",
        wsUrl: "ws://core.test/ws",
      } as never);
      vi.spyOn(serverCore, "stopCoreTestServer").mockResolvedValue(undefined);
      vi.spyOn(serverCore, "resetCoreTestDb").mockResolvedValue(undefined);
      vi.spyOn(agentFleet, "launchFleet").mockResolvedValue({
        stopAll: vi.fn().mockResolvedValue(undefined),
      } as never);
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
          contractMode: "shared",
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

      expect(result.summary.total).toBe(1);
      expect(result.summary.passed).toBe(0);
      expect(result.summary.failed).toBe(1);
      expect(fs.existsSync(bundleJsonPath)).toBe(true);
      expect(fs.existsSync(bundleYamlPath)).toBe(true);

      await verifyBundleWithCcJudge(bundleJsonPath, bundleYamlPath, runId);
      expect(serverCore.startCoreTestServer).toHaveBeenCalledTimes(1);
      expect(agentFleet.launchFleet).toHaveBeenCalledTimes(1);
      expect(clientTest.registerAgent).toHaveBeenCalledTimes(3);
    },
  );
});
