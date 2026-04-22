import { randomUUID } from "node:crypto";
import { Data, Effect } from "effect";
import type {
  RuntimeObservability,
  RuntimeProcessConfig,
} from "@moltzap/server-core";
import {
  loadEvalScenarioDocuments,
  stagePlannedHarnessArtifacts,
  type EvalScenarioSourceError,
} from "./scenario-source.js";
import type {
  EvalExecutionMode,
  EvalRunReceipt,
  EvalRunRequest,
  EvalRuntimeKind,
  LegacyEvalSurface,
  StagedPlannedHarnessCatalog,
} from "./types.js";

export interface EvalRuntimeDependencies {
  readonly runtimeConfig: RuntimeProcessConfig;
  readonly observability: RuntimeObservability;
}

export class EvalRuntimeSurfaceError extends Data.TaggedError(
  "EvalRuntimeSurfaceError",
)<{
  readonly cause:
    | {
        readonly _tag: "UnsupportedRuntime";
        readonly runtime: EvalRuntimeKind;
      }
    | {
        readonly _tag: "CcJudgeSurfaceUnavailable";
        readonly message: string;
      }
    | {
        readonly _tag: "LegacyModeRequiresExplicitOptIn";
        readonly surface: LegacyEvalSurface;
      }
    | {
        readonly _tag: "ObservabilityUnavailable";
        readonly message: string;
      };
}> {}

function brandRunId(value: string) {
  return value as EvalRunReceipt["runId"];
}

export function resolveEvalExecutionMode(input: {
  readonly request: EvalRunRequest;
  readonly stagedHarness: StagedPlannedHarnessCatalog;
}): Effect.Effect<EvalExecutionMode, EvalRuntimeSurfaceError, never> {
  if (input.request.requestedMode === "legacy-llm-judge") {
    return Effect.succeed({
      _tag: "LegacyLlmJudgeExplicit",
      requestedBy: "cli-flag",
      surface: "llm-judge",
    });
  }

  if (input.stagedHarness.artifacts.length === 0) {
    return Effect.fail(
      new EvalRuntimeSurfaceError({
        cause: {
          _tag: "CcJudgeSurfaceUnavailable",
          message: "no planned-harness artifacts were staged",
        },
      }),
    );
  }

  return Effect.succeed({
    _tag: "CcJudgeDefault",
    plannedHarnessInput: input.stagedHarness.executionInput,
  });
}

export function runEvalCatalog(
  deps: EvalRuntimeDependencies,
  request: EvalRunRequest,
): Effect.Effect<
  EvalRunReceipt,
  EvalRuntimeSurfaceError | EvalScenarioSourceError,
  never
> {
  const effect = Effect.gen(function* () {
    const loaded = yield* loadEvalScenarioDocuments(request.scenarioDocuments);
    const stagedHarness = yield* stagePlannedHarnessArtifacts({
      documents: loaded,
      resultsDirectory: request.resultsDirectory,
    });
    const executionMode = yield* resolveEvalExecutionMode({
      request,
      stagedHarness,
    });

    yield* Effect.sync(() => {
      deps.observability.logger.info(
        {
          configPath: deps.runtimeConfig.configPath,
          stagedDocuments: loaded.length,
          executionMode: executionMode._tag,
        },
        "staged eval runtime surface",
      );
    });

    return {
      runId: brandRunId(randomUUID()),
      executionMode,
      resultsDirectory: request.resultsDirectory,
      stagedHarness,
    } satisfies EvalRunReceipt;
  });

  return deps.observability.annotate({ workflow: "eval" }, effect);
}
