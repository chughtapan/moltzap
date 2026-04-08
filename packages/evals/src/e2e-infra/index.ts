#!/usr/bin/env node

/** CLI entry point for the E2E eval runner. */

import { config } from "dotenv";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from packages/evals/
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runE2EEvals } from "./runner.js";
import { TIER5_SCENARIOS } from "./scenarios.js";
import {
  AGENT_MODELS,
  DEFAULT_JUDGE_MODEL,
  resolveAgentModel,
  resolveAllAgentModels,
} from "./model-config.js";
import { setupLogger, logger } from "./logger.js";

// --- Signal handling: ensure eval containers are cleaned up on exit ---
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
        execSync(
          'docker ps -q --filter "label=moltzap-eval=true" | xargs -r docker rm -f',
          { stdio: "pipe" },
        );
      } catch {
        // best effort
      }
      process.exit(1);
    }, 10_000).unref();
  });
}

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .option("model", {
      type: "string",
      description: "Agent model to run evals against (e.g., zai/glm-4.7)",
      choices: AGENT_MODELS.map((m) => m.id),
    })
    .option("all-models", {
      type: "boolean",
      description: "Run evals against all configured agent models",
      default: false,
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
      description: "Model to use for LLM-as-judge evaluation",
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
    .check((args) => {
      if (!args.model && !args["all-models"]) {
        throw new Error(
          "Must specify --model <provider/model-id> or --all-models.\n" +
            `Available models: ${AGENT_MODELS.map((m) => m.id).join(", ")}`,
        );
      }
      if (args.model && args["all-models"]) {
        throw new Error("Cannot specify both --model and --all-models.");
      }
      return true;
    })
    .help()
    .alias("h", "help")
    .strict().argv;

  setupLogger(argv.results, argv["log-level"]);

  // Resolve which agent models to run
  const agentModels = argv["all-models"]
    ? resolveAllAgentModels()
    : [resolveAgentModel(argv.model!)];

  for (const agentModel of agentModels) {
    logger.info(
      `\n${"=".repeat(60)}\nRunning evals with agent model: ${agentModel.id}\n${"=".repeat(60)}`,
    );
    logger.info(
      `Scenarios: ${argv.scenario?.join(", ") ?? "all"} | Runs: ${argv["runs-per-scenario"]} | Judge: ${argv["eval-model"]}`,
    );

    const resultsDir =
      argv.results ?? `results/output-${agentModel.id.replace(/[/:]/g, "_")}`;

    try {
      const result = await runE2EEvals({
        scenarios: argv.scenario,
        model: agentModel.id,
        agentModel,
        runsPerScenario: argv["runs-per-scenario"],
        evalModel: argv["eval-model"],
        resultsDir,
        cleanResults: argv["clean-results"],
        logLevel: argv["log-level"],
        signal: shutdownController.signal,
      });

      logger.info(
        `[${agentModel.id}] Done: ${result.summary.passed}/${result.summary.total} passed (${result.summary.avgLatencyMs.toFixed(0)}ms avg)`,
      );

      if (result.summary.failed > 0) {
        process.exitCode = 1;
      }
    } catch (e: unknown) {
      const err = e as Error;
      logger.error(`[${agentModel.id}] Fatal: ${err.message}`);
      process.exitCode = 2;
    }
  }

  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
