#!/usr/bin/env node
/** @file Effect CLI for evaluation execution, resume, calibration, and publication. */

import { Command as CliCommand, Options } from "@effect/cli";
import { Command, Path } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import {
  simulatorLayer,
  type CompletedLedgerReceipt,
} from "@moltzap/simulator";
import { DateTime, Duration, Either, Effect, Option, Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import {
  evaluationCase,
  evaluationCases,
  type BundledEvaluationCase,
  type EvaluationCaseMetadata,
} from "./cases.js";
import {
  behavioralEvaluation,
  EvaluationExecutionFailed,
  nanoclawEvaluationCondition,
  openClawEvaluationCondition,
  type EvaluationCondition,
  type EvaluationExecutionResult,
} from "./execution.js";
import {
  GradeCompleted,
  GradingRefused,
  OPENAI_SEMANTIC_JUDGE_MODEL,
  OPENAI_SEMANTIC_JUDGE_TIMEOUT_MILLIS,
  SemanticJudgeOpenAi,
  gradeTranscript,
  runSemanticJudgeCalibration,
  transcriptFromLedger,
  type EvaluationTranscript,
} from "./grading.js";
import { decodeJudgePolicyId, type JudgePolicyId } from "./model.js";
import { PhoenixPublisher, phoenixPublisherLive } from "./phoenix.js";
import {
  createStoredEvaluationReport,
  evaluationResultPath,
  evaluationResultStoreLayer,
  loadEvaluationReport,
  resumeStoredEvaluationReport,
  runEvaluationSweep,
} from "./results.js";
import {
  CompletedEvaluationReport,
  EvaluationCasePlan,
  EvaluationConditionPlan,
  EvaluationReportPlan,
  EvidenceRejectedAttempt,
  JudgePolicySnapshot,
  LedgerAllocationFailedAttempt,
  RunFailedAttempt,
  decodeEvaluationReportId,
  ensureSweepOperationallyComplete,
  evaluationReportId,
  makeAssessedAttempt,
  makeJudgingUnavailableAttempt,
  type EvaluationReportId,
  type EvaluationSweepCell,
  type TerminalAttempt,
} from "./sweep.js";

const CLI_VERSION = "0.0.0";
const RUNTIME_STARTUP_TIMEOUT = Duration.minutes(5);
const ROUTER_STARTUP_TIMEOUT = Duration.minutes(10);
const PEER_OBSERVATION_TIMEOUT = Duration.minutes(5);
const CASE_TIMEOUT = Duration.minutes(20);
const LEDGER_DIRECTORY = [".moltzap", "evals", "ledgers"] as const;
const JUDGE_POLICY: JudgePolicyId = decodeJudgePolicyId(
  "openai-gpt-5.6-sol/v1",
);

/** The checked-out source cannot identify one reproducible report plan. */
class EvaluationSourceStateError extends Schema.TaggedError<EvaluationSourceStateError>()(
  "EvaluationSourceStateError",
  {
    detail: Schema.NonEmptyString,
  },
) {}

/** A durable matrix cell cannot bind to the current code catalog. */
class EvaluationPlanBindingError extends Schema.TaggedError<EvaluationPlanBindingError>()(
  "EvaluationPlanBindingError",
  {
    detail: Schema.NonEmptyString,
  },
) {}

/** Calibration ran, but one or more fixtures were not established. */
class SemanticJudgeCalibrationFailed extends Schema.TaggedError<SemanticJudgeCalibrationFailed>()(
  "SemanticJudgeCalibrationFailed",
  {
    fixtureIds: Schema.NonEmptyArray(Schema.NonEmptyString),
  },
) {}

interface RuntimeOptions {
  readonly openclawModel: string;
  readonly nanoclawModel: string;
}

interface AttemptContext {
  readonly cell: EvaluationSweepCell;
  readonly definition: BundledEvaluationCase;
  readonly startedAt: DateTime.Utc;
}

function describeUnknown(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  const detail = String(cause).trim();
  return detail.length > 0 ? detail : "operation failed without a diagnostic";
}

function sourceCommand(...args: readonly string[]) {
  return Command.make("git", ...args).pipe(Command.stderr("inherit"));
}

const workspaceRoot = Effect.fn("evals.workspaceRoot")(function* () {
  const root = yield* Command.string(
    sourceCommand("rev-parse", "--show-toplevel"),
  ).pipe(
    Effect.mapError((cause) =>
      EvaluationSourceStateError.make({
        detail: `unable to resolve workspace root: ${describeUnknown(cause)}`,
      }),
    ),
  );
  const normalized = root.trim();
  if (normalized.length === 0) {
    return yield* Effect.fail(
      EvaluationSourceStateError.make({
        detail: "git returned an empty workspace root",
      }),
    );
  }
  return normalized;
});

const exactSourceRevision = Effect.fn("evals.exactSourceRevision")(
  function* () {
    const status = yield* Command.string(
      sourceCommand("status", "--porcelain=v1", "--untracked-files=normal"),
    ).pipe(
      Effect.mapError((cause) =>
        EvaluationSourceStateError.make({
          detail: `unable to inspect source state: ${describeUnknown(cause)}`,
        }),
      ),
    );
    if (status.trim().length > 0) {
      return yield* Effect.fail(
        EvaluationSourceStateError.make({
          detail:
            "the worktree is dirty; commit the exact source before starting or resuming a report",
        }),
      );
    }
    const revision = yield* Command.string(
      sourceCommand("rev-parse", "HEAD"),
    ).pipe(
      Effect.mapError((cause) =>
        EvaluationSourceStateError.make({
          detail: `unable to resolve source revision: ${describeUnknown(cause)}`,
        }),
      ),
    );
    const normalized = revision.trim();
    if (!/^[\da-f]{40,64}$/u.test(normalized)) {
      return yield* Effect.fail(
        EvaluationSourceStateError.make({
          detail: "git returned an invalid source revision",
        }),
      );
    }
    return normalized;
  },
);

function evaluationConditions(
  options: RuntimeOptions,
): readonly [EvaluationCondition, EvaluationCondition] {
  const execution = {
    peerObservationTimeout: PEER_OBSERVATION_TIMEOUT,
    caseTimeout: CASE_TIMEOUT,
  } as const;
  return [
    openClawEvaluationCondition({
      runtime: {
        installMode: "workspace",
        startupTimeout: RUNTIME_STARTUP_TIMEOUT,
        modelId: options.openclawModel,
      },
      execution,
    }),
    nanoclawEvaluationCondition({
      runtime: {
        installMode: "workspace",
        autoRegisterConversations: true,
        startupTimeout: RUNTIME_STARTUP_TIMEOUT,
        modelId: options.nanoclawModel,
      },
      execution,
    }),
  ];
}

function judgePolicySnapshot(): JudgePolicySnapshot {
  return JudgePolicySnapshot.make({
    id: JUDGE_POLICY,
    provider: "openai",
    model: OPENAI_SEMANTIC_JUDGE_MODEL,
    reasoningEffort: "medium",
    structuredOutput: true,
    tools: "none",
    timeoutMillis: OPENAI_SEMANTIC_JUDGE_TIMEOUT_MILLIS,
    maxRetries: 2,
  });
}

function casePlan(definition: EvaluationCaseMetadata): EvaluationCasePlan {
  const [firstCriterion, ...remainingCriteria] = definition.criteria;
  return EvaluationCasePlan.make({
    id: definition.id,
    definitionId: definition.definitionId,
    name: definition.name,
    description: definition.description,
    rubric: definition.rubric,
    criterionIds: [
      firstCriterion.criterion.id,
      ...remainingCriteria.map(({ criterion }) => criterion.id),
    ],
    slices: definition.slices,
  });
}

function conditionPlan(
  condition: EvaluationCondition,
): EvaluationConditionPlan {
  return EvaluationConditionPlan.make({
    id: condition.id,
    runtimeName: condition.runtimeName,
    runtimeConfiguration: condition.runtimeConfiguration,
  });
}

function reportPlan(
  sourceRevision: string,
  conditions: NonEmptyReadonlyArray<EvaluationCondition>,
): EvaluationReportPlan {
  const [firstCase, ...remainingCases] = evaluationCases;
  const [firstCondition, ...remainingConditions] = conditions;
  return EvaluationReportPlan.make({
    sourceRevision,
    cases: [casePlan(firstCase), ...remainingCases.map(casePlan)],
    conditions: [
      conditionPlan(firstCondition),
      ...remainingConditions.map(conditionPlan),
    ],
    judgePolicy: judgePolicySnapshot(),
    samplesPerCell: 1,
  });
}

function bindCase(
  cell: EvaluationSweepCell,
): Effect.Effect<BundledEvaluationCase, EvaluationPlanBindingError> {
  const definition = evaluationCase(cell.casePlan.id);
  return definition === undefined
    ? Effect.fail(
        EvaluationPlanBindingError.make({
          detail: `unknown evaluation case ${cell.casePlan.id}`,
        }),
      )
    : Effect.succeed(definition);
}

function bindCondition(
  conditions: readonly EvaluationCondition[],
  cell: EvaluationSweepCell,
): Effect.Effect<EvaluationCondition, EvaluationPlanBindingError> {
  const condition = conditions.find(
    (candidate) => candidate.id === cell.conditionPlan.id,
  );
  return condition === undefined
    ? Effect.fail(
        EvaluationPlanBindingError.make({
          detail: `unknown evaluation condition ${cell.conditionPlan.id}`,
        }),
      )
    : Effect.succeed(condition);
}

function terminalFields(context: AttemptContext, completedAt: DateTime.Utc) {
  return {
    attemptId: context.cell.attemptId,
    caseId: context.cell.casePlan.id,
    conditionId: context.cell.conditionPlan.id,
    sample: context.cell.sample,
    startedAt: context.startedAt,
    completedAt,
  } as const;
}

function rejectEvidence(
  context: AttemptContext,
  receipt: CompletedLedgerReceipt,
  detail: string,
) {
  return DateTime.now.pipe(
    Effect.map((completedAt) =>
      EvidenceRejectedAttempt.make({
        ...terminalFields(context, completedAt),
        receipt,
        detail,
      }),
    ),
  );
}

function persistGrade(
  context: AttemptContext,
  receipt: CompletedLedgerReceipt,
  transcript: EvaluationTranscript,
) {
  return gradeTranscript(context.definition, transcript, JUDGE_POLICY).pipe(
    Effect.matchEffect({
      onFailure: (failure) => rejectEvidence(context, receipt, failure.detail),
      onSuccess: (outcome) =>
        Effect.gen(function* () {
          const fields = terminalFields(context, yield* DateTime.now);
          if (outcome instanceof GradeCompleted) {
            return yield* makeAssessedAttempt({
              ...fields,
              receipt,
              transcript,
              grade: outcome.report,
            });
          }
          return yield* makeJudgingUnavailableAttempt({
            ...fields,
            receipt,
            transcript,
            codeAssessments: outcome.codeAssessments,
            pendingCriterionIds: outcome.pendingCriterionIds,
            error: outcome.error,
          });
        }),
    }),
  );
}

function assessExecution(
  context: AttemptContext,
  receipt: CompletedLedgerReceipt,
) {
  return behavioralEvaluation.openLedger(receipt.ledger).pipe(
    Effect.flatMap((ledger) =>
      transcriptFromLedger(ledger, context.definition),
    ),
    Effect.matchEffect({
      onFailure: (failure) =>
        rejectEvidence(
          context,
          receipt,
          failure instanceof GradingRefused
            ? failure.detail
            : describeUnknown(failure),
        ),
      onSuccess: (transcript) => persistGrade(context, receipt, transcript),
    }),
  );
}

function completeExecution(
  context: AttemptContext,
  outcome: EvaluationExecutionResult,
) {
  return Effect.gen(function* () {
    if (outcome instanceof EvaluationExecutionFailed) {
      return RunFailedAttempt.make({
        ...terminalFields(context, yield* DateTime.now),
        receipt: outcome.receipt,
        detail: outcome.detail,
      });
    }
    return yield* assessExecution(context, outcome.receipt);
  });
}

function executeCell(
  conditions: readonly EvaluationCondition[],
  cell: EvaluationSweepCell,
) {
  return Effect.gen(function* () {
    const definition = yield* bindCase(cell);
    const condition = yield* bindCondition(conditions, cell);
    const context: AttemptContext = {
      cell,
      definition,
      startedAt: yield* DateTime.now,
    };
    const execution = yield* definition
      .withDefinition({
        execute: (exact) =>
          condition.execute(exact, { attemptId: cell.attemptId }),
      })
      .pipe(Effect.either);
    return yield* Either.match(execution, {
      onLeft: (failure) =>
        DateTime.now.pipe(
          Effect.map(
            (completedAt): TerminalAttempt =>
              LedgerAllocationFailedAttempt.make({
                ...terminalFields(context, completedAt),
                failure,
              }),
          ),
        ),
      onRight: (outcome) =>
        completeExecution(context, outcome).pipe(
          Effect.map((attempt): TerminalAttempt => attempt),
        ),
    });
  }).pipe(Effect.withSpan("evals.executeCell"));
}

function reportLocation(root: string, reportId: EvaluationReportId) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const relative = yield* evaluationResultPath(reportId);
    return path.join(root, relative);
  });
}

function reportIdNow() {
  return DateTime.now.pipe(
    Effect.map((now) =>
      decodeEvaluationReportId(
        DateTime.formatIso(now).toLowerCase().replaceAll(":", "-"),
      ),
    ),
  );
}

function simulatorPlatform(ledgerDirectory: string) {
  return simulatorLayer({
    ledgerDirectory,
    router: { startupTimeout: ROUTER_STARTUP_TIMEOUT },
  });
}

function executeReport(
  ledgerDirectory: string,
  conditions: readonly EvaluationCondition[],
) {
  return runEvaluationSweep((cell) => executeCell(conditions, cell)).pipe(
    Effect.provide(SemanticJudgeOpenAi),
    Effect.provide(simulatorPlatform(ledgerDirectory)),
  );
}

function logReport(report: CompletedEvaluationReport, path: string) {
  const assessed = report.attempts.filter(
    (attempt) => attempt._tag === "AssessedAttempt",
  ).length;
  return Effect.logInfo(
    `evaluation report ${report.reportId}: ${String(assessed)}/${String(report.attempts.length)} assessed attempts; ${path}`,
  );
}

const reportIdOption = Options.text("report-id").pipe(
  Options.withSchema(evaluationReportId),
  Options.withDescription("Durable local report identity."),
);
const optionalReportIdOption = reportIdOption.pipe(Options.optional);
const openclawModelOption = Options.text("openclaw-model").pipe(
  Options.withSchema(Schema.NonEmptyString),
  Options.withDescription("Exact OpenClaw model ID."),
);
const nanoclawModelOption = Options.text("nanoclaw-model").pipe(
  Options.withSchema(Schema.NonEmptyString),
  Options.withDescription("Exact NanoClaw model ID."),
);
const runtimeOptions = {
  openclawModel: openclawModelOption,
  nanoclawModel: nanoclawModelOption,
} as const;

function runOrResume(
  mode: "run" | "resume",
  reportId: Option.Option<EvaluationReportId>,
  options: RuntimeOptions,
) {
  return Effect.gen(function* () {
    const root = yield* workspaceRoot();
    const sourceRevision = yield* exactSourceRevision();
    const conditions = evaluationConditions(options);
    const plan = reportPlan(sourceRevision, conditions);
    const resolvedId = Option.isSome(reportId)
      ? reportId.value
      : yield* reportIdNow();
    const databasePath = yield* reportLocation(root, resolvedId);
    const path = yield* Path.Path;
    const ledgerDirectory = path.join(root, ...LEDGER_DIRECTORY);
    return yield* Effect.gen(function* () {
      if (mode === "run") {
        yield* createStoredEvaluationReport(resolvedId, plan);
      } else {
        yield* resumeStoredEvaluationReport(plan);
      }
      const completed = yield* executeReport(ledgerDirectory, conditions);
      yield* logReport(completed, databasePath);
      return yield* ensureSweepOperationallyComplete(completed);
    }).pipe(Effect.provide(evaluationResultStoreLayer(databasePath)));
  });
}

const runCommand = CliCommand.make(
  "run",
  {
    reportId: optionalReportIdOption,
    ...runtimeOptions,
  },
  ({ reportId, ...options }) => runOrResume("run", reportId, options),
).pipe(
  CliCommand.withDescription(
    "Run the complete OpenClaw and NanoClaw evaluation matrix.",
  ),
);

const resumeCommand = CliCommand.make(
  "resume",
  {
    reportId: reportIdOption,
    ...runtimeOptions,
  },
  ({ reportId, ...options }) =>
    runOrResume("resume", Option.some(reportId), options),
).pipe(
  CliCommand.withDescription(
    "Validate the immutable plan and execute missing matrix cells.",
  ),
);

const calibrateCommand = CliCommand.make("calibrate", {}, () =>
  Effect.gen(function* () {
    const report = yield* runSemanticJudgeCalibration();
    yield* Effect.logInfo(JSON.stringify(report));
    const failures = report.results
      .filter((result) => result._tag !== "JudgeCalibrationPassed")
      .map((result) => result.fixtureId);
    const [first, ...remaining] = failures;
    if (first !== undefined) {
      return yield* Effect.fail(
        SemanticJudgeCalibrationFailed.make({
          fixtureIds: [first, ...remaining],
        }),
      );
    }
    return report;
  }).pipe(Effect.provide(SemanticJudgeOpenAi)),
).pipe(
  CliCommand.withDescription(
    "Run the fixed semantic-judge calibration corpus.",
  ),
);

const publishCommand = CliCommand.make(
  "publish",
  { reportId: reportIdOption },
  ({ reportId }) =>
    Effect.gen(function* () {
      const root = yield* workspaceRoot();
      const databasePath = yield* reportLocation(root, reportId);
      const report = yield* loadEvaluationReport().pipe(
        Effect.provide(evaluationResultStoreLayer(databasePath)),
      );
      if (!(report instanceof CompletedEvaluationReport)) {
        return yield* Effect.fail(
          EvaluationSourceStateError.make({
            detail: `report ${reportId} is not complete`,
          }),
        );
      }
      const publisher = yield* PhoenixPublisher;
      const publication = yield* publisher.publish(report);
      yield* Effect.logInfo(JSON.stringify(publication));
      return publication;
    }).pipe(Effect.provide(phoenixPublisherLive)),
).pipe(
  CliCommand.withDescription(
    "Idempotently publish a completed report to Phoenix.",
  ),
);

const evaluationCommand = CliCommand.make("moltzap-evals").pipe(
  CliCommand.withDescription(
    "Code-first behavioral evaluations for MoltZap societies.",
  ),
  CliCommand.withSubcommands([
    runCommand,
    resumeCommand,
    calibrateCommand,
    publishCommand,
  ]),
);

const cli = CliCommand.run(evaluationCommand, {
  name: "moltzap-evals",
  version: CLI_VERSION,
});

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- @effect/cli owns argv decoding at the process boundary.
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
