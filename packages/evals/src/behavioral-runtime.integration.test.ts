/**
 * @file Opt-in behavioral measurement against real agent runtimes.
 *
 * Enable with `MOLTZAP_BEHAVIORAL_EVAL_ITEST=1`. Optional model overrides are
 * read from `MOLTZAP_OPENCLAW_EVAL_MODEL` and
 * `MOLTZAP_NANOCLAW_EVAL_MODEL`.
 */
import { it } from "@effect/vitest";
import {
  nanoclawRuntime,
  openClawRuntime,
  simulatorLayer,
  type LedgerFailure,
  type NetworkFailure,
  type SimulatorRunResult,
} from "@moltzap/simulator";
import { Config, Duration, Effect, Exit } from "effect";
import { defineEvaluationSuite, type CodeEvaluation } from "./evaluations.js";
import type { GradeReport } from "./grading-report.js";

const INTEGRATION_ENABLED = Effect.runSync(
  Config.string("MOLTZAP_BEHAVIORAL_EVAL_ITEST").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
);
const OPENCLAW_MODEL = optionalConfig("MOLTZAP_OPENCLAW_EVAL_MODEL");
const NANOCLAW_MODEL = optionalConfig("MOLTZAP_NANOCLAW_EVAL_MODEL");
const RUNTIME_STARTUP_TIMEOUT = Duration.minutes(5);
const ROUTER_STARTUP_TIMEOUT = Duration.minutes(10);
const EVALUATION_TIMEOUT = Duration.minutes(20);
const MEASUREMENT_TIMEOUT = Duration.minutes(45);
const TEST_RUNNER_MARGIN_MS = 5 * 60_000;
const LEDGER_ROOT = "../../eval-results";
function optionalConfig(name: string): string | undefined {
  const value = Effect.runSync(
    Config.string(name).pipe(Config.withDefault("")),
  ).trim();
  return value.length === 0 ? undefined : value;
}

const openClawEvaluation = defineEvaluationSuite(
  openClawRuntime({
    installMode: "workspace",
    startupTimeout: RUNTIME_STARTUP_TIMEOUT,
    ...(OPENCLAW_MODEL === undefined ? {} : { modelId: OPENCLAW_MODEL }),
  }),
  "-openclaw-live",
).eval021;

const nanoClawEvaluation = defineEvaluationSuite(
  nanoclawRuntime({
    installMode: "workspace",
    autoRegisterConversations: true,
    startupTimeout: RUNTIME_STARTUP_TIMEOUT,
    ...(NANOCLAW_MODEL === undefined ? {} : { modelId: NANOCLAW_MODEL }),
  }),
  "-nanoclaw-live",
).eval021;

type BehavioralRun = SimulatorRunResult<
  undefined,
  NetworkFailure | LedgerFailure
>;

function measurementResult<E, R>(
  runtime: string,
  evaluation: CodeEvaluation<E, R>,
  run: BehavioralRun,
  report: GradeReport,
) {
  return Object.freeze({
    type: "moltzap.behavioral-measurement/v1",
    runtime,
    scenarioId: evaluation.description.scenarioId,
    definitionId: evaluation.definitionId,
    condition: evaluation.defaults.provenance.condition,
    ledgerRef: run.ledger,
    runId: run.completion.runId,
    completion: Object.freeze({
      ledgerFormatVersion: run.completion.ledgerFormatVersion,
      recordCount: run.completion.recordCount,
      artifacts: Object.freeze({ ...run.completion.artifacts }),
    }),
    graderId: report.graderId,
    verdict: report.verdict,
    checks: report.checks.map((check) =>
      Object.freeze({
        name: check.name,
        outcome: check.outcome,
        detail: check.detail,
      }),
    ),
  });
}

const measureBehavior = Effect.fn("evals.measureRealAgentBehavior")(function* <
  E,
  R,
>(runtime: string, evaluation: CodeEvaluation<E, R>) {
  const run = yield* evaluation.run.pipe(Effect.timeout(EVALUATION_TIMEOUT));
  if (Exit.isFailure(run.exit)) {
    return yield* Effect.failCause(run.exit.cause);
  }
  const report = yield* evaluation.grade(run.ledger);
  const result = measurementResult(runtime, evaluation, run, report);
  yield* Effect.logInfo(`MOLTZAP_BEHAVIORAL_RESULT ${JSON.stringify(result)}`);
  return result;
});

const behavioralMeasurement = Effect.fn("evals.measureRealAgentBehaviors")(
  function* () {
    yield* measureBehavior("openclaw", openClawEvaluation);
    yield* measureBehavior("nanoclaw", nanoClawEvaluation);
  },
);

const platformLayer = simulatorLayer({
  ledgerDirectory: LEDGER_ROOT,
  router: { startupTimeout: ROUTER_STARTUP_TIMEOUT },
});

it.scopedLive.skipIf(!INTEGRATION_ENABLED)(
  "grades EVAL-021 sequentially against OpenClaw and NanoClaw",
  () =>
    behavioralMeasurement().pipe(
      Effect.provide(platformLayer),
      Effect.timeout(MEASUREMENT_TIMEOUT),
    ),
  Duration.toMillis(MEASUREMENT_TIMEOUT) + TEST_RUNNER_MARGIN_MS,
);
