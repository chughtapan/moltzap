import { Effect } from "effect";

import {
  buildJudgmentBundle,
  deriveJudgmentRunId,
  writeJudgmentBundleArtifacts,
} from "./judgment-bundle.js";
import {
  createRunCompletedTelemetryEvent,
  telemetry,
  type SharedContractTelemetryEvent,
} from "./telemetry.js";
import type { EvalRuntimeKind } from "./eval-runtime.js";
import type { E2ERunResult, ValidatedResult } from "./types.js";

export interface SharedContractEvaluationInput {
  readonly validated: ReadonlyArray<ValidatedResult>;
  readonly outputDir?: string;
  readonly project: string;
  readonly runtime: EvalRuntimeKind;
  readonly agentId: string;
  readonly agentName: string;
  readonly telemetryEvents: ReadonlyArray<SharedContractTelemetryEvent>;
}

function isScenarioScopedTelemetryEvent(
  event: SharedContractTelemetryEvent,
): event is Extract<
  SharedContractTelemetryEvent,
  { scenarioId: string; runNumber: number }
> {
  return "scenarioId" in event && "runNumber" in event;
}

function buildSharedSummary(results: ReadonlyArray<ValidatedResult>): E2ERunResult {
  const passed = results.filter(
    (result) =>
      !result.error &&
      result.validationErrors.length === 0,
  ).length;
  const totalLatency = results.reduce(
    (sum, result) => sum + result.latencyMs,
    0,
  );

  return {
    results: [...results],
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      avgLatencyMs: results.length > 0 ? totalLatency / results.length : 0,
    },
  };
}

export function runSharedContractEvaluation(
  input: SharedContractEvaluationInput,
): Effect.Effect<{ result: E2ERunResult }, never, never> {
  return Effect.gen(function* () {
    const bundlesDir = input.outputDir
      ? `${input.outputDir}/bundles`
      : undefined;

    yield* Effect.sync(() => {
      for (const result of input.validated) {
        const runId = deriveJudgmentRunId({
          scenarioId: result.scenarioId,
          runNumber: result.runNumber,
          modelName: result.modelName,
        });
        const status = result.error
          ? "runtime_failure"
          : result.validationErrors.length > 0
            ? "validation_failure"
            : "success";

        telemetry.emit(
          createRunCompletedTelemetryEvent({
            ts: new Date().toISOString(),
            runId,
            scenarioId: result.scenarioId,
            runNumber: result.runNumber,
            status,
          }),
        );

        if (!bundlesDir) {
          continue;
        }

        const bundle = buildJudgmentBundle({
          project: input.project,
          runId,
          scenario: result.scenario,
          generated: result,
          validated: result,
          agentId: input.agentId,
          agentName: input.agentName,
          runtime: input.runtime,
          telemetryEvents: input.telemetryEvents.filter(
            (event) =>
              event._tag === "fleet.started" ||
              event._tag === "fleet.stopped" ||
              (isScenarioScopedTelemetryEvent(event) &&
                event.scenarioId === result.scenarioId &&
                event.runNumber === result.runNumber),
          ),
        });
        writeJudgmentBundleArtifacts(bundle, bundlesDir);
      }
    });

    const results: ValidatedResult[] = input.validated.map((result) => ({
      ...result,
    }));

    return {
      result: buildSharedSummary(results),
    };
  });
}
