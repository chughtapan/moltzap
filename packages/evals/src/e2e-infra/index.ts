#!/usr/bin/env node

/** CLI entry point for the E2E eval runner. */

import { config } from "dotenv";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from packages/evals/
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

import { Effect } from "effect";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runE2EEvals } from "./runner.js";
import { TIER5_SCENARIOS } from "./scenarios.js";
import { DEFAULT_AGENT_MODEL_ID, DEFAULT_JUDGE_MODEL } from "./model-config.js";
import { setupLogger, logger } from "./logger.js";

// --- Signal handling: ensure eval containers are cleaned up on exit ---
const EVAL_CONTAINER_LABEL = "moltzap-eval=true";
const shutdownController = new AbortController();
let shuttingDown = false;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1); // second signal = hard exit
    shuttingDown = true;
    console.error(`\nReceived ${sig}, shutting down eval containers...`);
    shutdownController.abort();
    // Fallback: force-kill labeled containers if graceful shutdown hangs
    setTimeout(() => {
      try {
        const ids = execSync(
          `docker ps -q --filter "label=${EVAL_CONTAINER_LABEL}"`,
          { encoding: "utf-8" },
        ).trim();
        if (ids) {
          execSync(`docker rm -f ${ids.split("\n").join(" ")}`, {
            stdio: "pipe",
          });
        }
      } catch (err) {
        // SIGINT force-cleanup: best-effort but still report so an
        // operator knows why containers may linger.
        console.error(
          `eval cleanup: docker rm failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      process.exit(1);
    }, 10_000).unref();
  });
}

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: yargs CLI entrypoint
async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .option("model", {
      type: "string",
      description:
        "Agent model to run evals against (e.g., anthropic/claude-sonnet-4-20250514)",
      default: DEFAULT_AGENT_MODEL_ID,
    })
    .option("scenario", {
      type: "string",
      array: true,
      description: "Filter scenarios by ID prefix (e.g., EVAL-018)",
      choices: TIER5_SCENARIOS.map((s) => s.id),
    })
    .option("runs-per-scenario", {
      type: "number",
      description: "Number of times to run each scenario",
      default: 1,
    })
    .option("eval-model", {
      type: "string",
      description:
        "Judge model for cc-judge (default) or the legacy local judge path",
      default: DEFAULT_JUDGE_MODEL,
    })
    .option("results", {
      type: "string",
      description: "Output directory for results",
    })
    .option("clean-results", {
      type: "boolean",
      description: "Clear the output directory before starting",
      default: false,
    })
    .option("log-level", {
      type: "string",
      description: "Set the logging level",
      default: "info",
      choices: ["debug", "info", "warn", "error"],
    })
    .option("runtime", {
      type: "string",
      description:
        "Agent runtime to spin up: openclaw (default, containerized) or nanoclaw (host subprocess via the shared runtime abstraction)",
      default: "openclaw",
      choices: ["openclaw", "nanoclaw"],
    })
    .option("execution-mode", {
      type: "string",
      description:
        "Evaluation path: cc-judge (default) or the legacy local judge path",
      default: "cc-judge",
      choices: ["cc-judge", "legacy-llm-judge"],
    })
    .help()
    .alias("h", "help")
    .strict().argv;

  setupLogger(argv.results, argv["log-level"]);

  const modelId = argv.model!;
  const executionMode = argv["execution-mode"] as
    | "cc-judge"
    | "legacy-llm-judge";

  logger.info(
    `\n${"=".repeat(60)}\nRunning evals with agent model: ${modelId}\n${"=".repeat(60)}`,
  );
  logger.info(
    `Scenarios: ${argv.scenario?.join(", ") ?? "all"} | Runs: ${argv["runs-per-scenario"]} | Judge: ${argv["eval-model"]} | Execution: ${executionMode}`,
  );

  const resultsDir =
    argv.results ?? `results/output-${modelId.replace(/[/:]/g, "_")}`;

  // `runE2EEvals` is Effect-native. The CLI entry point (process boundary)
  // runs it through `Effect.runPromise` — the same pattern the rest of the
  // codebase uses to cross into Node-idiomatic async.
  try {
    const result = await Effect.runPromise(
      runE2EEvals({
        scenarios: argv.scenario,
        agentModelId: modelId,
        runsPerScenario: argv["runs-per-scenario"],
        evalModel: argv["eval-model"],
        resultsDir,
        cleanResults: argv["clean-results"],
        logLevel: argv["log-level"],
        signal: shutdownController.signal,
        runtime: argv.runtime as "openclaw" | "nanoclaw", // #ignore-sloppy-code[enum-cast]: yargs choices constrain to these values at parse time
        executionMode,
      }),
    );

    logger.info(
      `[${modelId}] Done: ${result.summary.passed}/${result.summary.total} passed (${result.summary.avgLatencyMs.toFixed(0)}ms avg) [execution=${executionMode}]`,
    );

    if (result.summary.failed > 0) {
      process.exitCode = 1;
    }
  } catch (e: unknown) {
    const err = e as Error;
    logger.error(`[${modelId}] Fatal: ${err.message}`);
    process.exitCode = 2;
  }

  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
