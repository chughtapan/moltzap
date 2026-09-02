#!/usr/bin/env node
/** @file Effect CLI for evaluation execution, resume, calibration, and publication. */

import type { NonEmptyReadonlyArray } from "effect/Array";
import { Command as CliCommand, Options } from "@effect/cli";
import { Command, Path } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import {
  type CompletedLedgerReceipt,
  isEntryModule,
  type ProfileRunResult,
} from "@moltzap/simulator";
import { image, type Image } from "@moltzap/simulator/agents";
import {
  type CompletedLedgerArtifacts,
  LedgerStorageError,
} from "@moltzap/simulator/ledger";
import { Config, DateTime, Duration, Effect, Option, Schema } from "effect";
import {
  type ArtifactBucket,
  evaluationArtifactBucket,
  evaluationArtifactLocation,
  type EvaluationArtifactStorage,
  localArtifactRoot,
  type LocalArtifactRoot,
  readEvaluationLedgerArtifacts,
} from "./artifacts.js";
import { GradeCompleted, gradeTranscript } from "./assessment.js";
import { runSemanticJudgeCalibration } from "./calibration.js";
import {
  type BundledEvaluationCase,
  evaluationCase,
  type EvaluationCaseMetadata,
} from "./cases.js";
import {
  type EvaluationCondition,
  EvaluationExecutionFailed,
  type EvaluationExecutionResult,
  nanoclawEvaluationCondition,
  openClawEvaluationCondition,
  openEvaluationLedger,
  projectEvaluationControllerResult,
} from "./execution.js";
import {
  OPENAI_SEMANTIC_JUDGE_MODEL,
  OPENAI_SEMANTIC_JUDGE_TIMEOUT_MILLIS,
  SemanticJudgeOpenAi,
} from "./judge-openai.js";
import {
  decodeJudgePolicyId,
  type EvaluationConditionId,
  type EvaluationConditionName,
  type JudgePolicyId,
} from "./model.js";
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
  evaluationRunCliOptions,
  type EvaluationRunCliOptions,
  type EvaluationRunOptions,
  EvaluationSelectionInvalid,
  resolveEvaluationRunSelection,
} from "./selection.js";
import { submissionDiagnostic, submitEvaluationCell } from "./submission.js";
import {
  CompletedEvaluationReport,
  decodeEvaluationReportId,
  ensureSweepOperationallyComplete,
  EvaluationCasePlan,
  EvaluationConditionPlan,
  type EvaluationInfrastructure,
  evaluationReportId,
  type EvaluationReportId,
  EvaluationReportPlan,
  type EvaluationSweepCell,
  EvidenceRejectedAttempt,
  GkeEvaluationInfrastructure,
  JudgePolicySnapshot,
  LedgerAllocationFailedAttempt,
  LocalEvaluationInfrastructure,
  makeAssessedAttempt,
  makeJudgingUnavailableAttempt,
  RunFailedAttempt,
} from "./sweep.js";
import {
  type EvaluationTranscript,
  GradingRefused,
  transcriptFromLedger,
} from "./transcript.js";

const CLI_VERSION = "0.0.0";
const RUNTIME_STARTUP_TIMEOUT = Duration.minutes(5);
// Concurrent cells queue behind each other for the profile's capacity; an
// hour lets a full sweep's worth wait without failing as ClusterLost.
const ADMISSION_TIMEOUT = Duration.hours(1);
const PEER_OBSERVATION_TIMEOUT = Duration.minutes(5);
const CASE_TIMEOUT = Duration.minutes(20);
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

interface CommonExecutionEnvironment {
  readonly workspaceRoot: string;
  readonly openclawApplicationImage?: Image;
  readonly nanoclawApplicationImage?: Image;
  readonly controllerImage: Image;
  readonly temporalAddress: string;
  readonly messagingMode: "shared" | "private";
  readonly models: Readonly<{
    readonly openclaw?: string;
    readonly nanoclaw?: string;
  }>;
}

interface LocalExecutionEnvironment extends CommonExecutionEnvironment {
  readonly profile: "local";
  readonly localArtifacts: LocalArtifactRoot;
}

interface GkeExecutionEnvironment extends CommonExecutionEnvironment {
  readonly profile: "gke";
  readonly kubeContext: string;
  readonly gkeArtifactBucket: ArtifactBucket;
}

// Each profile carries exactly the target it needs. One flat record with
// optional fields would let a plan be built for a profile whose artifact target
// was never resolved, and the only place to catch that is a runtime throw.
type EvaluationExecutionEnvironment =
  | LocalExecutionEnvironment
  | GkeExecutionEnvironment;

interface EvaluationExecutionImages {
  readonly controllerImage: Image;
  readonly openclawApplicationImage?: Image;
  readonly nanoclawApplicationImage?: Image;
}

/** One cell's identity while its attempt is being produced. */
export interface AttemptContext {
  readonly cell: EvaluationSweepCell;
  readonly definition: BundledEvaluationCase;
  readonly startedAt: DateTime.Utc;
}

/** Environment key naming one digest-pinned image an evaluation run needs. */
export type EvaluationImageKey =
  | "MOLTZAP_CONTROLLER_IMAGE"
  | "MOLTZAP_OPENCLAW_IMAGE"
  | "MOLTZAP_NANOCLAW_IMAGE";

/**
 * Record an infrastructure failure, with whatever account the run left.
 * @param context Cell identity and the instant execution began.
 * @param summary Terminal summary the controller printed for this cell.
 * @param diagnostic The controller's own account, when it produced one.
 * @returns The terminal attempt this cell commits.
 */
export function infrastructureFailed(
  context: AttemptContext,
  summary: InfrastructureSummary,
  diagnostic?: string,
) {
  return DateTime.now.pipe(
    Effect.map((completedAt) => {
      const detail = diagnostic ?? infrastructureFailureDetail(summary);
      const fields = terminalFields(context, completedAt);
      return summary._tag === "LedgerAllocationFailed"
        ? LedgerAllocationFailedAttempt.make({
            ...fields,
            failure: LedgerStorageError.make({ operation: "allocate", detail }),
          })
        : RunFailedAttempt.make({
            ...fields,
            receipt: summary.receipt,
            detail,
          });
    }),
  );
}

/**
 * Describe an evaluation image the environment omitted.
 * @param key Environment key the run could not read.
 * @returns The operator-facing requirement.
 */
export function missingImageDetail(key: EvaluationImageKey): string {
  return `${key} is required for evaluation execution`;
}

/**
 * Describe a rejected evaluation image reference.
 * @param key Environment key whose value was not digest-pinned.
 * @returns The operator-facing requirement.
 */
export function invalidImageDetail(key: EvaluationImageKey): string {
  return `${key} must be a lowercase SHA-256 digest-pinned image`;
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
  options: EvaluationRunOptions,
  environment: Pick<
    CommonExecutionEnvironment,
    "openclawApplicationImage" | "nanoclawApplicationImage"
  >,
): NonEmptyReadonlyArray<EvaluationCondition> {
  switch (options.runtime) {
    case "openclaw": {
      const openclawApplicationImage = selectedApplicationImage(
        "MOLTZAP_OPENCLAW_IMAGE",
        environment.openclawApplicationImage,
      );
      return [openClawCondition(options, openclawApplicationImage)];
    }
    case "nanoclaw": {
      const nanoclawApplicationImage = selectedApplicationImage(
        "MOLTZAP_NANOCLAW_IMAGE",
        environment.nanoclawApplicationImage,
      );
      return [nanoClawCondition(options, nanoclawApplicationImage)];
    }
    case "all": {
      const openclawApplicationImage = selectedApplicationImage(
        "MOLTZAP_OPENCLAW_IMAGE",
        environment.openclawApplicationImage,
      );
      const nanoclawApplicationImage = selectedApplicationImage(
        "MOLTZAP_NANOCLAW_IMAGE",
        environment.nanoclawApplicationImage,
      );
      return [
        openClawCondition(options, openclawApplicationImage),
        nanoClawCondition(options, nanoclawApplicationImage),
      ];
    }
    default:
      throw EvaluationSourceStateError.make({
        detail: "evaluation runtime selection is unsupported",
      });
  }
}

function selectedApplicationImage(
  key: EvaluationImageKey,
  selected?: Image,
): Image {
  if (selected === undefined) {
    throw EvaluationSourceStateError.make({ detail: missingImageDetail(key) });
  }
  return selected;
}

function openClawCondition(
  options: EvaluationRunOptions,
  applicationImage: Image,
): EvaluationCondition {
  if (options.openclawModel === undefined) {
    throw EvaluationSourceStateError.make({
      detail: "selected OpenClaw condition has no model",
    });
  }
  const execution = {
    peerObservationTimeout: PEER_OBSERVATION_TIMEOUT,
    caseTimeout: CASE_TIMEOUT,
  } as const;
  return openClawEvaluationCondition({
    runtime: {
      applicationImage,
      startupTimeout: RUNTIME_STARTUP_TIMEOUT,
      modelId: options.openclawModel,
      messagingMode: options.messagingMode,
    },
    execution,
  });
}

function nanoClawCondition(
  options: EvaluationRunOptions,
  applicationImage: Image,
): EvaluationCondition {
  if (options.nanoclawModel === undefined) {
    throw EvaluationSourceStateError.make({
      detail: "selected NanoClaw condition has no model",
    });
  }
  return nanoclawEvaluationCondition({
    runtime: {
      applicationImage,
      startupTimeout: RUNTIME_STARTUP_TIMEOUT,
      modelId: options.nanoclawModel,
    },
    execution: {
      peerObservationTimeout: PEER_OBSERVATION_TIMEOUT,
      caseTimeout: CASE_TIMEOUT,
    },
  });
}

function reportPlan(
  sourceRevision: string,
  cases: NonEmptyReadonlyArray<EvaluationCaseMetadata>,
  conditions: NonEmptyReadonlyArray<EvaluationCondition>,
  environment: EvaluationExecutionEnvironment,
): EvaluationReportPlan {
  const [firstCase, ...remainingCases] = cases;
  const [firstCondition, ...remainingConditions] = conditions;
  return EvaluationReportPlan.make({
    sourceRevision,
    cases: [casePlan(firstCase), ...remainingCases.map(casePlan)],
    conditions: [
      conditionPlan(firstCondition),
      ...remainingConditions.map(conditionPlan),
    ],
    judgePolicy: judgePolicySnapshot(),
    infrastructure: planInfrastructure(environment),
    samplesPerCell: 1,
  });
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

function planInfrastructure(
  environment: EvaluationExecutionEnvironment,
): EvaluationInfrastructure {
  const shared = {
    controllerImage: environment.controllerImage,
    temporalAddress: environment.temporalAddress,
    ...(environment.openclawApplicationImage === undefined
      ? {}
      : {
          openclawApplicationImage: environment.openclawApplicationImage,
        }),
    ...(environment.nanoclawApplicationImage === undefined
      ? {}
      : {
          nanoclawApplicationImage: environment.nanoclawApplicationImage,
        }),
  };
  return environment.profile === "local"
    ? LocalEvaluationInfrastructure.make({
        ...shared,
        profile: environment.profile,
        artifactDirectory: environment.localArtifacts,
      })
    : GkeEvaluationInfrastructure.make({
        ...shared,
        profile: environment.profile,
        kubeContext: environment.kubeContext,
        artifactBucket: environment.gkeArtifactBucket,
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

/** Summary of a submission that never reached a gradeable run. */
type InfrastructureSummary = Exclude<
  ProfileRunResult["result"]["summary"],
  { readonly _tag: "ProgramFinished" }
>;

// A run that never got a ledger and a run that lost its cluster are different
// operator problems, and this text is all that says which happened when the
// controller left no account of its own.
const INFRASTRUCTURE_FAILED_DETAIL: Readonly<
  Record<InfrastructureSummary["_tag"], string>
> = {
  LedgerAllocationFailed:
    "the simulator controller could not allocate its durable ledger",
  ClusterLost: "the simulator controller reported an infrastructure failure",
};

function infrastructureFailureDetail(summary: InfrastructureSummary): string {
  return INFRASTRUCTURE_FAILED_DETAIL[summary._tag];
}

function completeSubmission(
  environment: EvaluationExecutionEnvironment,
  context: AttemptContext,
  submission: ProfileRunResult,
) {
  const summary = submission.result.summary;
  return summary._tag === "ProgramFinished"
    ? readCompletedArtifacts(
        environment,
        context,
        submission.namespace,
        summary.receipt,
      )
    : infrastructureFailed(context, summary, submissionDiagnostic(submission));
}

function readCompletedArtifacts(
  environment: EvaluationExecutionEnvironment,
  context: AttemptContext,
  namespace: string,
  receipt: CompletedLedgerReceipt,
) {
  return Option.match(
    evaluationArtifactLocation(
      artifactStorage(environment),
      namespace,
      receipt.ledger,
    ),
    {
      onNone: () =>
        rejectEvidence(
          context,
          receipt,
          "the controller ledger ref is not one artifact path segment",
        ),
      onSome: (location) =>
        readEvaluationLedgerArtifacts(location).pipe(
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
        ),
    },
  );
}

function artifactStorage(
  environment: EvaluationExecutionEnvironment,
): EvaluationArtifactStorage {
  return environment.profile === "local"
    ? { profile: environment.profile, root: environment.localArtifacts }
    : { profile: environment.profile, bucket: environment.gkeArtifactBucket };
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
      modelId: conditionModelId(environment.models, condition.id),
    },
    messagingMode: environment.messagingMode,
    ...(environment.openclawApplicationImage === undefined
      ? {}
      : {
          openclawApplicationImage: environment.openclawApplicationImage,
        }),
    ...(environment.nanoclawApplicationImage === undefined
      ? {}
      : {
          nanoclawApplicationImage: environment.nanoclawApplicationImage,
        }),
    runtimeStartupTimeoutMillis: Duration.toMillis(RUNTIME_STARTUP_TIMEOUT),
    admissionTimeoutMillis: Duration.toMillis(ADMISSION_TIMEOUT),
    peerObservationTimeoutMillis: Duration.toMillis(PEER_OBSERVATION_TIMEOUT),
    caseTimeoutMillis: Duration.toMillis(CASE_TIMEOUT),
  } as const;
}

function conditionModelId(
  models: CommonExecutionEnvironment["models"],
  condition: EvaluationConditionId,
): string {
  const byCondition: Readonly<
    Record<EvaluationConditionName, string | undefined>
  > = {
    "openclaw/v2": models.openclaw,
    "nanoclaw/v2": models.nanoclaw,
  };
  // Indexing needs the plain spelling; the brand is not part of the key set.
  const name: EvaluationConditionName = condition;
  const model = byCondition[name];
  if (model === undefined) {
    throw EvaluationSourceStateError.make({
      detail: `no model was resolved for selected condition ${name}`,
    });
  }
  return model;
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
  concurrency: number,
) {
  return runEvaluationSweep(
    (cell) => executeCell(environment, conditions, cell),
    { concurrency },
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
function executionImages(options: EvaluationRunOptions) {
  return Effect.gen(function* () {
    const controllerImage = yield* requiredImage("MOLTZAP_CONTROLLER_IMAGE");
    if (options.runtime === "openclaw") {
      return {
        controllerImage,
        openclawApplicationImage: yield* requiredImage(
          "MOLTZAP_OPENCLAW_IMAGE",
        ),
      };
    }
    if (options.runtime === "nanoclaw") {
      return {
        controllerImage,
        nanoclawApplicationImage: yield* requiredImage(
          "MOLTZAP_NANOCLAW_IMAGE",
        ),
      };
    }
    return {
      controllerImage,
      openclawApplicationImage: yield* requiredImage("MOLTZAP_OPENCLAW_IMAGE"),
      nanoclawApplicationImage: yield* requiredImage("MOLTZAP_NANOCLAW_IMAGE"),
    };
  });
}

function requiredImage(key: EvaluationImageKey) {
  return Config.string(key).pipe(
    Effect.mapError(() =>
      EvaluationSourceStateError.make({ detail: missingImageDetail(key) }),
    ),
    Effect.flatMap((value: string) => distributedApplicationImage(key, value)),
  );
}

function distributedApplicationImage(
  key: EvaluationImageKey,
  value: string,
): Effect.Effect<Image, EvaluationSourceStateError> {
  return Schema.decodeUnknown(image)(value).pipe(
    Effect.mapError(() =>
      EvaluationSourceStateError.make({ detail: invalidImageDetail(key) }),
    ),
  );
}

function localArtifactDirectory(path: Path.Path) {
  return requiredArtifactTarget(
    "MOLTZAP_LOCAL_ARTIFACTS",
    "an absolute path",
    (value) => localArtifactRoot(path, value),
  );
}

function gkeArtifactBucket() {
  return requiredArtifactTarget(
    "MOLTZAP_GKE_ARTIFACT_BUCKET",
    "a valid Cloud Storage bucket name",
    evaluationArtifactBucket,
  );
}

function requiredArtifactTarget<Target>(
  key: "MOLTZAP_LOCAL_ARTIFACTS" | "MOLTZAP_GKE_ARTIFACT_BUCKET",
  requirement: string,
  accept: (value: string) => Option.Option<Target>,
) {
  return requiredEnvironment(key).pipe(
    Effect.flatMap((value) =>
      Option.match(accept(value), {
        onNone: () =>
          Effect.fail(
            EvaluationSourceStateError.make({
              detail: `${key} must be ${requirement}`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
}

function requiredEnvironment(key: string) {
  return Config.string(key).pipe(
    Effect.mapError(() =>
      EvaluationSourceStateError.make({
        detail: `${key} is required for evaluation execution`,
      }),
    ),
  );
}

function commonEnvironment(
  root: string,
  options: EvaluationRunOptions,
  images: EvaluationExecutionImages,
) {
  return {
    workspaceRoot: root,
    ...images,
    messagingMode: options.messagingMode,
    models: {
      ...(options.openclawModel === undefined
        ? {}
        : { openclaw: options.openclawModel }),
      ...(options.nanoclawModel === undefined
        ? {}
        : { nanoclaw: options.nanoclawModel }),
    },
  } as const;
}

function executionEnvironment(
  root: string,
  options: EvaluationRunOptions,
): Effect.Effect<
  EvaluationExecutionEnvironment,
  EvaluationSourceStateError,
  Path.Path
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const common = {
      ...commonEnvironment(root, options, yield* executionImages(options)),
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
  cliOptions: EvaluationRunCliOptions,
) {
  return Effect.gen(function* () {
    const selection = yield* Effect.try({
      try: () => resolveEvaluationRunSelection(cliOptions),
      catch: (cause) =>
        cause instanceof EvaluationSelectionInvalid
          ? EvaluationSourceStateError.make({ detail: cause.detail })
          : EvaluationSourceStateError.make({
              detail: describeUnknown(cause),
            }),
    });
    const { options } = selection;
    const root = yield* workspaceRoot();
    const sourceRevision = yield* exactSourceRevision();
    const environment = yield* executionEnvironment(root, options);
    const conditions = evaluationConditions(options, environment);
    const plan = reportPlan(
      sourceRevision,
      selection.cases,
      conditions,
      environment,
    );
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
      const completed = yield* executeReport(
        environment,
        conditions,
        selection.concurrency,
      );
      yield* logReport(completed, databasePath);
      return yield* ensureSweepOperationallyComplete(completed);
    }).pipe(Effect.provide(evaluationResultStoreLayer(databasePath)));
  });
}

const runCommand = CliCommand.make(
  "run",
  {
    reportId: optionalReportIdOption,
    ...evaluationRunCliOptions,
  },
  ({ reportId, ...options }) => runOrResume("run", reportId, options),
).pipe(CliCommand.withDescription("Run the selected evaluation matrix."));

const resumeCommand = CliCommand.make(
  "resume",
  {
    reportId: reportIdOption,
    ...evaluationRunCliOptions,
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

// Guarded so this module can be imported: without it, reading any value here
// runs the CLI against the importer's argv.
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Direct-entry detection has no Effect Platform equivalent.
if (isEntryModule(import.meta.url, process.argv[1])) {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- @effect/cli owns argv decoding at the process boundary.
  cli(process.argv).pipe(
    Effect.provide(NodeContext.layer),
    NodeRuntime.runMain,
  );
}
