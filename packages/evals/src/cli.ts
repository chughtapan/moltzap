#!/usr/bin/env node
/** @file Effect CLI for evaluation execution, resume, calibration, and publication. */

import { Command as CliCommand, Options } from "@effect/cli";
import { Command, Path } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import type { CompletedLedgerReceipt } from "@moltzap/simulator";
import {
  LedgerStorageError,
  type CompletedLedgerArtifacts,
} from "@moltzap/simulator/ledger";
import type { Image } from "@moltzap/simulator/agents";
import { Config, DateTime, Duration, Effect, Option, Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import {
  evaluationCase,
  evaluationCases,
  type BundledEvaluationCase,
  type EvaluationCaseMetadata,
} from "./cases.js";
import {
  EvaluationExecutionFailed,
  nanoclawEvaluationCondition,
  openEvaluationLedger,
  openClawEvaluationCondition,
  projectEvaluationControllerResult,
  type EvaluationCondition,
  type EvaluationExecutionResult,
} from "./execution.js";
import { readEvaluationLedgerArtifacts } from "./artifacts.js";
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
  GkeEvaluationInfrastructure,
  EvidenceRejectedAttempt,
  JudgePolicySnapshot,
  LedgerAllocationFailedAttempt,
  LocalEvaluationInfrastructure,
  RunFailedAttempt,
  decodeEvaluationReportId,
  ensureSweepOperationallyComplete,
  evaluationReportId,
  makeAssessedAttempt,
  makeJudgingUnavailableAttempt,
  type EvaluationReportId,
  type EvaluationSweepCell,
} from "./sweep.js";
import {
  submitEvaluationCell,
  type EvaluationSubmissionResult,
  type SimulatorProfile,
} from "./submission.js";

const CLI_VERSION = "0.0.0";
const RUNTIME_STARTUP_TIMEOUT = Duration.minutes(5);
const PEER_OBSERVATION_TIMEOUT = Duration.minutes(5);
const CASE_TIMEOUT = Duration.minutes(20);
const DISTRIBUTED_IMAGE = /^.+@sha256:[0-9a-f]{64}$/u;
const GCS_BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u;
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
  readonly profile: SimulatorProfile;
}

interface EvaluationExecutionEnvironment {
  readonly workspaceRoot: string;
  readonly profile: SimulatorProfile;
  readonly peerApplicationImage: Image;
  readonly nanoclawApplicationImage: Image;
  readonly controllerImage: Image;
  readonly temporalAddress: string;
  readonly kubeContext?: string;
  readonly localArtifacts?: string;
  readonly gkeArtifactBucket?: string;
  readonly models: Readonly<{
    readonly openclaw: string;
    readonly nanoclaw: string;
  }>;
}

interface EvaluationExecutionImages {
  readonly controllerImage: Image;
  readonly peerApplicationImage: Image;
  readonly nanoclawApplicationImage: Image;
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
  nanoclawApplicationImage: Image,
): readonly [EvaluationCondition, EvaluationCondition] {
  const execution = {
    peerObservationTimeout: PEER_OBSERVATION_TIMEOUT,
    caseTimeout: CASE_TIMEOUT,
  } as const;
  return [
    openClawEvaluationCondition({
      runtime: {
        startupTimeout: RUNTIME_STARTUP_TIMEOUT,
        modelId: options.openclawModel,
      },
      execution,
    }),
    nanoclawEvaluationCondition({
      runtime: {
        applicationImage: nanoclawApplicationImage,
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
  environment: EvaluationExecutionEnvironment,
): EvaluationReportPlan {
  const [firstCase, ...remainingCases] = evaluationCases;
  const [firstCondition, ...remainingConditions] = conditions;
  if (environment.profile === "local") {
    if (environment.localArtifacts === undefined) {
      throw new Error(
        "local execution environment lacks an artifact directory",
      );
    }
    return EvaluationReportPlan.make({
      sourceRevision,
      cases: [casePlan(firstCase), ...remainingCases.map(casePlan)],
      conditions: [
        conditionPlan(firstCondition),
        ...remainingConditions.map(conditionPlan),
      ],
      judgePolicy: judgePolicySnapshot(),
      infrastructure: LocalEvaluationInfrastructure.make({
        profile: environment.profile,
        controllerImage: environment.controllerImage,
        peerApplicationImage: environment.peerApplicationImage,
        nanoclawApplicationImage: environment.nanoclawApplicationImage,
        temporalAddress: environment.temporalAddress,
        artifactDirectory: environment.localArtifacts,
      }),
      samplesPerCell: 1,
    });
  }
  if (
    environment.kubeContext === undefined ||
    environment.gkeArtifactBucket === undefined
  ) {
    throw new Error("GKE execution environment lacks its selected target");
  }
  return EvaluationReportPlan.make({
    sourceRevision,
    cases: [casePlan(firstCase), ...remainingCases.map(casePlan)],
    conditions: [
      conditionPlan(firstCondition),
      ...remainingConditions.map(conditionPlan),
    ],
    judgePolicy: judgePolicySnapshot(),
    infrastructure: GkeEvaluationInfrastructure.make({
      profile: environment.profile,
      controllerImage: environment.controllerImage,
      peerApplicationImage: environment.peerApplicationImage,
      nanoclawApplicationImage: environment.nanoclawApplicationImage,
      temporalAddress: environment.temporalAddress,
      kubeContext: environment.kubeContext,
      artifactBucket: environment.gkeArtifactBucket,
    }),
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
  artifacts: CompletedLedgerArtifacts,
) {
  return openEvaluationLedger(
    context.definition,
    receipt.ledger,
    artifacts,
  ).pipe(
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
  artifacts: CompletedLedgerArtifacts,
) {
  return Effect.gen(function* () {
    if (outcome instanceof EvaluationExecutionFailed) {
      return RunFailedAttempt.make({
        ...terminalFields(context, yield* DateTime.now),
        receipt: outcome.receipt,
        detail: outcome.detail,
      });
    }
    return yield* assessExecution(context, outcome.receipt, artifacts);
  });
}

function ledgerAllocationFailed(context: AttemptContext) {
  return DateTime.now.pipe(
    Effect.map((completedAt) =>
      LedgerAllocationFailedAttempt.make({
        ...terminalFields(context, completedAt),
        failure: LedgerStorageError.make({
          operation: "allocate",
          detail:
            "the simulator controller could not allocate its durable ledger",
        }),
      }),
    ),
  );
}

function runInfrastructureFailed(
  context: AttemptContext,
  receipt: EvaluationSubmissionResult["result"]["summary"] & {
    readonly _tag: "ClusterLost";
  },
) {
  return DateTime.now.pipe(
    Effect.map((completedAt) =>
      RunFailedAttempt.make({
        ...terminalFields(context, completedAt),
        receipt: receipt.receipt,
        detail: "the simulator controller reported an infrastructure failure",
      }),
    ),
  );
}

function completeSubmittedProgram(
  environment: EvaluationExecutionEnvironment,
  context: AttemptContext,
  namespace: string,
  receipt: CompletedLedgerReceipt,
) {
  return readEvaluationLedgerArtifacts({
    profile: environment.profile,
    namespace,
    ref: receipt.ledger,
    localArtifacts: environment.localArtifacts,
    gkeArtifactBucket: environment.gkeArtifactBucket,
  }).pipe(
    Effect.matchEffect({
      onFailure: (failure) =>
        rejectEvidence(context, receipt, describeUnknown(failure)),
      onSuccess: (artifacts) =>
        projectEvaluationControllerResult(
          context.definition,
          receipt,
          artifacts,
        ).pipe(
          Effect.matchEffect({
            onFailure: (failure) =>
              rejectEvidence(context, receipt, describeUnknown(failure)),
            onSuccess: (outcome) =>
              completeExecution(context, outcome, artifacts),
          }),
        ),
    }),
  );
}

function completeSubmission(
  environment: EvaluationExecutionEnvironment,
  context: AttemptContext,
  submission: EvaluationSubmissionResult,
) {
  const summary = submission.result.summary;
  if (summary._tag === "LedgerAllocationFailed") {
    return ledgerAllocationFailed(context);
  }
  if (summary._tag === "ClusterLost") {
    return runInfrastructureFailed(context, summary);
  }
  return completeSubmittedProgram(
    environment,
    context,
    submission.namespace,
    summary.receipt,
  );
}

function submissionInput(
  environment: EvaluationExecutionEnvironment,
  context: AttemptContext,
  condition: EvaluationCondition,
) {
  return {
    workspaceRoot: environment.workspaceRoot,
    profile: environment.profile,
    caseId: context.definition.id,
    definitionId: context.definition.definitionId,
    attemptId: context.cell.attemptId,
    condition: {
      id: condition.id,
      modelId:
        condition.id === "openclaw/v2"
          ? environment.models.openclaw
          : environment.models.nanoclaw,
    },
    peerApplicationImage: environment.peerApplicationImage,
    nanoclawApplicationImage: environment.nanoclawApplicationImage,
    runtimeStartupTimeoutMillis: Duration.toMillis(RUNTIME_STARTUP_TIMEOUT),
    peerObservationTimeoutMillis: Duration.toMillis(PEER_OBSERVATION_TIMEOUT),
    caseTimeoutMillis: Duration.toMillis(CASE_TIMEOUT),
  } as const;
}

function executeCell(
  environment: EvaluationExecutionEnvironment,
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
    const submission = yield* submitEvaluationCell(
      submissionInput(environment, context, condition),
    );
    return yield* completeSubmission(environment, context, submission);
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

function executeReport(
  environment: EvaluationExecutionEnvironment,
  conditions: readonly EvaluationCondition[],
) {
  return runEvaluationSweep((cell) =>
    executeCell(environment, conditions, cell),
  ).pipe(Effect.provide(SemanticJudgeOpenAi));
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
const profileOption = Options.text("profile").pipe(
  Options.withSchema(Schema.Literal("local", "gke")),
  Options.withDefault("local"),
  Options.withDescription("Repository-owned Kubernetes execution profile."),
);
const runtimeOptions = {
  openclawModel: openclawModelOption,
  nanoclawModel: nanoclawModelOption,
  profile: profileOption,
} as const;

function requiredEnvironment(key: string) {
  return Config.string(key).pipe(
    Effect.mapError(() =>
      EvaluationSourceStateError.make({
        detail: `${key} is required for evaluation execution`,
      }),
    ),
  );
}

function distributedApplicationImage(
  key:
    | "MOLTZAP_CONTROLLER_IMAGE"
    | "MOLTZAP_SUPPORT_IMAGE"
    | "MOLTZAP_NANOCLAW_IMAGE",
  value: string,
): Effect.Effect<Image, EvaluationSourceStateError> {
  if (!DISTRIBUTED_IMAGE.test(value)) {
    return Effect.fail(
      EvaluationSourceStateError.make({
        detail: `${key} must be a lowercase SHA-256 digest-pinned image`,
      }),
    );
  }
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The preceding exact digest pattern proves the simulator template-literal image contract.
  return Effect.succeed(value as Image);
}

function executionImages() {
  return Effect.all({
    controllerImage: requiredEnvironment("MOLTZAP_CONTROLLER_IMAGE").pipe(
      Effect.flatMap((value) =>
        distributedApplicationImage("MOLTZAP_CONTROLLER_IMAGE", value),
      ),
    ),
    peerApplicationImage: requiredEnvironment("MOLTZAP_SUPPORT_IMAGE").pipe(
      Effect.flatMap((value) =>
        distributedApplicationImage("MOLTZAP_SUPPORT_IMAGE", value),
      ),
    ),
    nanoclawApplicationImage: requiredEnvironment(
      "MOLTZAP_NANOCLAW_IMAGE",
    ).pipe(
      Effect.flatMap((value) =>
        distributedApplicationImage("MOLTZAP_NANOCLAW_IMAGE", value),
      ),
    ),
  });
}

function localArtifactDirectory(path: Path.Path) {
  return requiredEnvironment("MOLTZAP_LOCAL_ARTIFACTS").pipe(
    Effect.flatMap((value) =>
      path.isAbsolute(value)
        ? Effect.succeed(value)
        : Effect.fail(
            EvaluationSourceStateError.make({
              detail: "MOLTZAP_LOCAL_ARTIFACTS must be an absolute path",
            }),
          ),
    ),
  );
}

function gkeArtifactBucket() {
  return requiredEnvironment("MOLTZAP_GKE_ARTIFACT_BUCKET").pipe(
    Effect.flatMap((value) =>
      GCS_BUCKET.test(value)
        ? Effect.succeed(value)
        : Effect.fail(
            EvaluationSourceStateError.make({
              detail:
                "MOLTZAP_GKE_ARTIFACT_BUCKET must be a valid Cloud Storage bucket name",
            }),
          ),
    ),
  );
}

function commonEnvironment(
  root: string,
  options: RuntimeOptions,
  images: EvaluationExecutionImages,
) {
  return {
    workspaceRoot: root,
    ...images,
    models: {
      openclaw: options.openclawModel,
      nanoclaw: options.nanoclawModel,
    },
  } as const;
}

function executionEnvironment(
  root: string,
  options: RuntimeOptions,
): Effect.Effect<
  EvaluationExecutionEnvironment,
  EvaluationSourceStateError,
  Path.Path
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const common = {
      ...commonEnvironment(root, options, yield* executionImages()),
      temporalAddress: yield* requiredEnvironment("MOLTZAP_TEMPORAL_ADDRESS"),
    };
    if (options.profile === "local") {
      return {
        ...common,
        profile: options.profile,
        localArtifacts: yield* localArtifactDirectory(path),
      };
    }
    return {
      ...common,
      profile: options.profile,
      kubeContext: yield* requiredEnvironment("MOLTZAP_KUBE_CONTEXT"),
      gkeArtifactBucket: yield* gkeArtifactBucket(),
    };
  });
}

function runOrResume(
  mode: "run" | "resume",
  reportId: Option.Option<EvaluationReportId>,
  options: RuntimeOptions,
) {
  return Effect.gen(function* () {
    const root = yield* workspaceRoot();
    const sourceRevision = yield* exactSourceRevision();
    const environment = yield* executionEnvironment(root, options);
    const conditions = evaluationConditions(
      options,
      environment.nanoclawApplicationImage,
    );
    const plan = reportPlan(sourceRevision, conditions, environment);
    const resolvedId = Option.isSome(reportId)
      ? reportId.value
      : yield* reportIdNow();
    const databasePath = yield* reportLocation(root, resolvedId);
    return yield* Effect.gen(function* () {
      if (mode === "run") {
        yield* createStoredEvaluationReport(resolvedId, plan);
      } else {
        yield* resumeStoredEvaluationReport(plan);
      }
      const completed = yield* executeReport(environment, conditions);
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
