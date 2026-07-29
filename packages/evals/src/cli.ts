#!/usr/bin/env node
/** @file Effect CLI for live evaluation sweeps, judging, publication, and probes. */

import { Command as CliCommand, Options } from "@effect/cli";
import { Command, FileSystem, Path } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import {
  type LedgerReceipt,
  ProgramFinished,
  Simulator,
  nanoclawRuntime,
  openClawRuntime,
  runtimeConfigurationProjection,
  simulatorLayer,
} from "@moltzap/simulator";
import type { LedgerRef, LedgerStorageError } from "@moltzap/simulator/ledger";
import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Exit,
  Option,
  Schema,
} from "effect";
import {
  ConditionId,
  EvaluationCaseId,
  EvaluationCases,
  JudgePolicyId,
  type EvaluationCaseDefinition,
} from "./cases.js";
import { TARGET_AGENT_NAME } from "./episodes.js";
import {
  EvaluationEvents,
  participantAssignmentsForEpisode,
  readRuntimeTerminationEvidence,
  RuntimeTerminationEvidence,
  selectEvaluationResponse,
  type RuntimeEvidenceLedger,
  type RuntimeTerminationEvidenceReadOutcome,
  waitForRuntimeTerminationEvidence,
} from "./events.js";
import {
  GradeCompleted,
  GradingRefused,
  OPENAI_SEMANTIC_JUDGE_MODEL,
  OPENAI_SEMANTIC_JUDGE_TIMEOUT_MILLIS,
  SemanticJudgeOpenAi,
  type EvaluationLedgerView,
  gradeTranscript,
  runSemanticJudgeCalibration,
  transcriptFromLedger,
} from "./grading.js";
import { PhoenixPublisher, PhoenixPublisherLive } from "./phoenix.js";
import { SharedProbeFailed, runSharedConversationProbe } from "./probes.js";
import {
  CompletedEvaluationReport,
  EvaluationCasePlan,
  EvaluationConditionPlan,
  EvaluationReportId,
  EvaluationReportPlan,
  EvidenceRejectedAttempt,
  JudgePolicySnapshot,
  LedgerAllocationFailedAttempt,
  RunFailedAttempt,
  checkpointEvaluationReport,
  createEvaluationReport,
  ensureSweepOperationallyComplete,
  evaluationReportPath,
  loadEvaluationReport,
  makeAssessedAttempt,
  makeJudgingUnavailableAttempt,
  resumeEvaluationReport,
  runEvaluationSweep,
  type EvaluationSweepCell,
} from "./sweep.js";

const CLI_VERSION = "0.0.0";
const RUNTIME_STARTUP_TIMEOUT = Duration.minutes(5);
const ROUTER_STARTUP_TIMEOUT = Duration.minutes(10);
const EVALUATION_TIMEOUT = Duration.minutes(20);
const PositiveInteger = Schema.Int.pipe(Schema.positive());
const LEDGER_DIRECTORY = [".moltzap", "evals", "ledgers"] as const;
const OPENCLAW_CONDITION = Schema.decodeSync(ConditionId)("openclaw/v1");
const NANOCLAW_CONDITION = Schema.decodeSync(ConditionId)("nanoclaw/v1");
const JUDGE_POLICY = Schema.decodeSync(JudgePolicyId)("openai-gpt-5.6-sol/v1");

/** The checked-out source cannot identify an exact reproducible report plan. */
class EvaluationSourceStateError extends Schema.TaggedError<EvaluationSourceStateError>()(
  "EvaluationSourceStateError",
  {
    detail: Schema.NonEmptyString,
  },
) {}

/** A new sweep never replaces an existing durable report. */
class EvaluationReportAlreadyExists extends Schema.TaggedError<EvaluationReportAlreadyExists>()(
  "EvaluationReportAlreadyExists",
  {
    path: Schema.NonEmptyString,
  },
) {}

/** A decoded report cell cannot be bound to the current code-valued plan. */
class EvaluationPlanBindingError extends Schema.TaggedError<EvaluationPlanBindingError>()(
  "EvaluationPlanBindingError",
  {
    detail: Schema.NonEmptyString,
  },
) {}

/** A bounded case did not complete before its customer-owned deadline. */
class EvaluationEpisodeTimedOut extends Schema.TaggedError<EvaluationEpisodeTimedOut>()(
  "EvaluationEpisodeTimedOut",
  {
    caseId: EvaluationCaseId,
    timeoutMillis: PositiveInteger,
  },
) {}

/** Evaluation policy stops when its only autonomous target terminates. */
class EvaluationRuntimeTerminated extends Schema.TaggedError<EvaluationRuntimeTerminated>()(
  "EvaluationRuntimeTerminated",
  {
    observation: RuntimeTerminationEvidence,
  },
) {}

/** Calibration completed, but at least one fixture was not established. */
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

type OpenClawRuntime = ReturnType<typeof openClawRuntime>;
type NanoClawRuntime = ReturnType<typeof nanoclawRuntime>;

interface LiveCondition {
  readonly id: ConditionId;
  readonly runtime: OpenClawRuntime | NanoClawRuntime;
}

type EvaluationLedgerOpener<Failure, Requirements> = (
  ref: LedgerRef,
) => Effect.Effect<EvaluationLedgerView, Failure, Requirements>;

function describeUnknown(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  const detail = String(cause);
  return detail.length > 0 ? detail : "unknown failure";
}

function causeDetail(cause: Cause.Cause<unknown>): string {
  const detail = Cause.pretty(cause).trim();
  return detail.length > 0 ? detail : "execution failed without a diagnostic";
}

function baselineConditions(
  options: RuntimeOptions,
): ReadonlyArray<LiveCondition> {
  return [
    {
      id: OPENCLAW_CONDITION,
      runtime: openClawRuntime({
        installMode: "workspace",
        startupTimeout: RUNTIME_STARTUP_TIMEOUT,
        modelId: options.openclawModel,
      }),
    },
    {
      id: NANOCLAW_CONDITION,
      runtime: nanoclawRuntime({
        installMode: "workspace",
        autoRegisterConversations: true,
        startupTimeout: RUNTIME_STARTUP_TIMEOUT,
        modelId: options.nanoclawModel,
      }),
    },
  ];
}

function sourceCommand(...args: ReadonlyArray<string>) {
  return Command.make("git", ...args).pipe(Command.stderr("inherit"));
}

const exactSource = Effect.fn("evals.exactSource")(function* () {
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
          "the worktree is dirty; commit the exact source before starting or resuming a live report",
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
});

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

const reportPlan = Effect.fn("evals.reportPlan")(function* (
  sourceRevision: string,
  conditions: ReadonlyArray<LiveCondition>,
) {
  const casePlans = EvaluationCases.map((definition) => {
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
  });
  const [firstCase, ...remainingCases] = casePlans;
  const [firstCondition, ...remainingConditions] = conditions.map((condition) =>
    EvaluationConditionPlan.make({
      id: condition.id,
      runtimeName: condition.runtime.name,
      runtimeConfiguration: runtimeConfigurationProjection(condition.runtime),
    }),
  );
  if (firstCase === undefined || firstCondition === undefined) {
    return yield* Effect.fail(
      EvaluationPlanBindingError.make({
        detail: "the fixed evaluation matrix is empty",
      }),
    );
  }
  return EvaluationReportPlan.make({
    sourceRevision,
    cases: [firstCase, ...remainingCases],
    conditions: [firstCondition, ...remainingConditions],
    judgePolicy: judgePolicySnapshot(),
    samplesPerCell: 1,
  });
});

function caseFor(
  cell: EvaluationSweepCell,
): Effect.Effect<EvaluationCaseDefinition, EvaluationPlanBindingError> {
  const definition = EvaluationCases.find(
    (candidate) => candidate.id === cell.casePlan.id,
  );
  return definition === undefined
    ? Effect.fail(
        EvaluationPlanBindingError.make({
          detail: `unknown evaluation case ${cell.casePlan.id}`,
        }),
      )
    : Effect.succeed(definition);
}

function conditionFor(
  conditions: ReadonlyArray<LiveCondition>,
  cell: EvaluationSweepCell,
): Effect.Effect<LiveCondition, EvaluationPlanBindingError> {
  const condition = conditions.find(
    (candidate) => candidate.id === cell.conditionPlan.id,
  );
  return condition === undefined
    ? Effect.fail(
        EvaluationPlanBindingError.make({
          detail: `unknown runtime condition ${cell.conditionPlan.id}`,
        }),
      )
    : Effect.succeed(condition);
}

function episodeProgram(
  definition: EvaluationCaseDefinition,
  target: Parameters<EvaluationCaseDefinition["episode"]>[0],
  emit: (
    event:
      | ReturnType<typeof participantAssignmentsForEpisode>[number]
      | ReturnType<typeof selectEvaluationResponse>,
  ) => Effect.Effect<unknown, unknown>,
) {
  return Effect.gen(function* () {
    const result = yield* definition.episode(target);
    const assignments = participantAssignmentsForEpisode(definition.id, result);
    yield* Effect.forEach(assignments, (assignment) => emit(assignment), {
      concurrency: 1,
      discard: true,
    });
    yield* Effect.forEach(
      result.selectedResponses,
      (response) => emit(selectEvaluationResponse(definition.id, response)),
      { concurrency: 1, discard: true },
    );
  }).pipe(
    Effect.timeoutFail({
      duration: EVALUATION_TIMEOUT,
      onTimeout: () =>
        EvaluationEpisodeTimedOut.make({
          caseId: definition.id,
          timeoutMillis: Duration.toMillis(EVALUATION_TIMEOUT),
        }),
    }),
  );
}

function attemptFields(
  cell: EvaluationSweepCell,
  startedAt: DateTime.Utc,
  completedAt: DateTime.Utc,
) {
  return {
    attemptId: cell.attemptId,
    caseId: cell.casePlan.id,
    conditionId: cell.conditionPlan.id,
    sample: cell.sample,
    startedAt,
    completedAt,
  } as const;
}

function evidenceRejected(
  common: ReturnType<typeof attemptFields>,
  receipt: ProgramFinished<unknown, unknown>["receipt"],
  detail: string,
) {
  return EvidenceRejectedAttempt.make({
    ...common,
    receipt,
    detail,
  });
}

function runFailed(
  common: ReturnType<typeof attemptFields>,
  receipt: LedgerReceipt,
  cause: Cause.Cause<unknown>,
  runtimeEvidence: RuntimeTerminationEvidenceReadOutcome,
) {
  return RunFailedAttempt.make({
    ...common,
    receipt,
    detail: causeDetail(cause),
    runtimeEvidence,
  });
}

function gradeEvidence(
  definition: EvaluationCaseDefinition,
  common: ReturnType<typeof attemptFields>,
  receipt: ProgramFinished<unknown, unknown>["receipt"],
  transcript: Parameters<typeof gradeTranscript>[1],
) {
  return gradeTranscript(definition, transcript, JUDGE_POLICY).pipe(
    Effect.matchEffect({
      onFailure: (failure) =>
        Effect.succeed(evidenceRejected(common, receipt, failure.detail)),
      onSuccess: (graded) =>
        Effect.gen(function* () {
          return graded instanceof GradeCompleted
            ? yield* makeAssessedAttempt({
                ...common,
                receipt,
                transcript,
                grade: graded.report,
              })
            : yield* makeJudgingUnavailableAttempt({
                ...common,
                receipt,
                transcript,
                codeAssessments: graded.codeAssessments,
                pendingCriterionIds: graded.pendingCriterionIds,
                error: graded.error,
              });
        }),
    }),
  );
}

function openAndGrade<E, R>(
  definition: EvaluationCaseDefinition,
  common: ReturnType<typeof attemptFields>,
  receipt: ProgramFinished<unknown, unknown>["receipt"],
  open: Effect.Effect<Parameters<typeof transcriptFromLedger>[0], E, R>,
) {
  return open.pipe(
    Effect.flatMap((ledger) =>
      transcriptFromLedger(ledger, definition, TARGET_AGENT_NAME),
    ),
    Effect.matchEffect({
      onFailure: (failure) =>
        Effect.succeed(
          evidenceRejected(
            common,
            receipt,
            failure instanceof GradingRefused
              ? failure.detail
              : describeUnknown(failure),
          ),
        ),
      onSuccess: (transcript) =>
        gradeEvidence(definition, common, receipt, transcript),
    }),
  );
}

function allocationFailed(
  cell: EvaluationSweepCell,
  startedAt: DateTime.Utc,
  failure: LedgerStorageError,
) {
  return DateTime.now.pipe(
    Effect.map((completedAt) =>
      LedgerAllocationFailedAttempt.make({
        ...attemptFields(cell, startedAt, completedAt),
        failure,
      }),
    ),
  );
}

function completeAllocatedRun<OpenFailure, OpenRequirements>(
  definition: EvaluationCaseDefinition,
  common: ReturnType<typeof attemptFields>,
  outcome:
    | ProgramFinished<unknown, unknown>
    | {
        readonly cause: Cause.Cause<unknown>;
        readonly receipt: LedgerReceipt;
      },
  openLedger: EvaluationLedgerOpener<OpenFailure, OpenRequirements>,
) {
  return Effect.gen(function* () {
    if (!(outcome instanceof ProgramFinished)) {
      const runtimeEvidence = yield* readRuntimeTerminationEvidence(
        outcome.receipt,
        openLedger,
      );
      return runFailed(common, outcome.receipt, outcome.cause, runtimeEvidence);
    }
    if (Exit.isFailure(outcome.exit)) {
      const cause = outcome.exit.cause;
      const runtimeEvidence = yield* readRuntimeTerminationEvidence(
        outcome.receipt,
        openLedger,
      );
      return runFailed(common, outcome.receipt, cause, runtimeEvidence);
    }
    return yield* openAndGrade(
      definition,
      common,
      outcome.receipt,
      openLedger(outcome.receipt.ledger),
    );
  });
}

function failOnRuntimeTermination<Failure>(
  ledger: RuntimeEvidenceLedger<Failure>,
) {
  return waitForRuntimeTerminationEvidence(ledger).pipe(
    Effect.flatMap((observation) =>
      Effect.fail(EvaluationRuntimeTerminated.make({ observation })),
    ),
  );
}

function executeCell(
  conditions: ReadonlyArray<LiveCondition>,
  cell: EvaluationSweepCell,
) {
  return Effect.gen(function* () {
    const definition = yield* caseFor(cell);
    const condition = yield* conditionFor(conditions, cell);
    const society = Simulator.define(definition.definitionId, EvaluationEvents);
    const roster = society.agents({
      [TARGET_AGENT_NAME]: condition.runtime,
    });
    const startedAt = yield* DateTime.now;
    const program = Effect.gen(function* () {
      const agents = yield* roster.Agents;
      const events = yield* society.Events;
      const ledger = yield* society.Ledger;
      const episode = episodeProgram(
        definition,
        agents[TARGET_AGENT_NAME],
        (event) => events.emit(event),
      );
      yield* Effect.raceFirst(episode, failOnRuntimeTermination(ledger));
    });
    return yield* society
      .run(roster, program, {
        provenance: {
          evaluationCase: definition.id,
          evaluationCondition: condition.id,
        },
      })
      .pipe(
        Effect.matchEffect({
          onFailure: (failure) => allocationFailed(cell, startedAt, failure),
          onSuccess: (outcome) =>
            DateTime.now.pipe(
              Effect.flatMap((completedAt) =>
                completeAllocatedRun(
                  definition,
                  attemptFields(cell, startedAt, completedAt),
                  outcome,
                  society.openLedger,
                ),
              ),
            ),
        }),
      );
  }).pipe(Effect.withSpan("evals.executeCell"));
}

function reportLocation(root: string, reportId: EvaluationReportId) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const relative = yield* evaluationReportPath(reportId);
    return path.join(root, relative);
  });
}

function reportIdNow() {
  return DateTime.now.pipe(
    Effect.map((now) =>
      DateTime.formatIso(now).toLowerCase().replaceAll(":", "-"),
    ),
    Effect.flatMap(Schema.decodeUnknown(EvaluationReportId)),
  );
}

function logReport(report: CompletedEvaluationReport, path: string) {
  const assessed = report.attempts.filter(
    (attempt) => attempt._tag === "AssessedAttempt",
  ).length;
  return Effect.logInfo(
    `evaluation report ${report.reportId}: ${String(assessed)}/${String(report.attempts.length)} assessed; ${path}`,
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
  path: string,
  report: Parameters<typeof runEvaluationSweep>[1],
  conditions: ReadonlyArray<LiveCondition>,
) {
  return runEvaluationSweep(path, report, (cell) =>
    executeCell(conditions, cell),
  ).pipe(
    Effect.provide(SemanticJudgeOpenAi),
    Effect.provide(simulatorPlatform(ledgerDirectory)),
  );
}

const reportIdOption = Options.text("report-id").pipe(
  Options.withSchema(EvaluationReportId),
  Options.withDescription("Durable local report identity."),
);

const optionalReportIdOption = reportIdOption.pipe(Options.optional);

const openclawModelOption = Options.text("openclaw-model").pipe(
  Options.withSchema(Schema.NonEmptyString),
  Options.withDescription(
    "Exact OpenClaw model ID to bind into execution provenance.",
  ),
);

const nanoclawModelOption = Options.text("nanoclaw-model").pipe(
  Options.withSchema(Schema.NonEmptyString),
  Options.withDescription(
    "Exact NanoClaw model ID to bind into execution provenance.",
  ),
);

const runtimeOptions = {
  openclawModel: openclawModelOption,
  nanoclawModel: nanoclawModelOption,
} as const;

const runCommand = CliCommand.make(
  "run",
  {
    reportId: optionalReportIdOption,
    ...runtimeOptions,
  },
  ({ reportId, ...options }) =>
    Effect.gen(function* () {
      const root = yield* workspaceRoot();
      const sourceRevision = yield* exactSource();
      const conditions = baselineConditions(options);
      const plan = yield* reportPlan(sourceRevision, conditions);
      const resolvedId = Option.isSome(reportId)
        ? reportId.value
        : yield* reportIdNow();
      const path = yield* reportLocation(root, resolvedId);
      const platformPath = yield* Path.Path;
      const ledgerDirectory = platformPath.join(root, ...LEDGER_DIRECTORY);
      const fileSystem = yield* FileSystem.FileSystem;
      if (yield* fileSystem.exists(path)) {
        return yield* Effect.fail(EvaluationReportAlreadyExists.make({ path }));
      }
      const initial = yield* createEvaluationReport(resolvedId, plan);
      yield* checkpointEvaluationReport(path, initial);
      const completed = yield* executeReport(
        ledgerDirectory,
        path,
        initial,
        conditions,
      );
      yield* logReport(completed, path);
      return yield* ensureSweepOperationallyComplete(completed);
    }),
).pipe(
  CliCommand.withDescription(
    "Run the full OpenClaw and NanoClaw matrix sequentially.",
  ),
);

const resumeCommand = CliCommand.make(
  "resume",
  {
    reportId: reportIdOption,
    ...runtimeOptions,
  },
  ({ reportId, ...options }) =>
    Effect.gen(function* () {
      const root = yield* workspaceRoot();
      const sourceRevision = yield* exactSource();
      const conditions = baselineConditions(options);
      const plan = yield* reportPlan(sourceRevision, conditions);
      const path = yield* reportLocation(root, reportId);
      const platformPath = yield* Path.Path;
      const ledgerDirectory = platformPath.join(root, ...LEDGER_DIRECTORY);
      const report = yield* resumeEvaluationReport(path, plan);
      const completed = yield* executeReport(
        ledgerDirectory,
        path,
        report,
        conditions,
      );
      yield* logReport(completed, path);
      return yield* ensureSweepOperationallyComplete(completed);
    }),
).pipe(
  CliCommand.withDescription(
    "Validate a report plan and execute only missing matrix cells.",
  ),
);

const publishCommand = CliCommand.make(
  "publish",
  { reportId: reportIdOption },
  ({ reportId }) =>
    Effect.gen(function* () {
      const root = yield* workspaceRoot();
      const path = yield* reportLocation(root, reportId);
      const report = yield* loadEvaluationReport(path);
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
    }).pipe(Effect.provide(PhoenixPublisherLive)),
).pipe(
  CliCommand.withDescription(
    "Idempotently publish one completed report to external Phoenix.",
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
    "Run the fixed semantic-judge calibration corpus sequentially.",
  ),
);

const probeCommand = CliCommand.make("probe", runtimeOptions, (options) =>
  Effect.gen(function* () {
    const root = yield* workspaceRoot();
    const path = yield* Path.Path;
    const ledgerDirectory = path.join(root, ...LEDGER_DIRECTORY);
    const outcome = yield* runSharedConversationProbe({
      openClawModel: options.openclawModel,
      nanoClawModel: options.nanoclawModel,
    }).pipe(Effect.provide(simulatorPlatform(ledgerDirectory)));
    yield* Effect.logInfo(JSON.stringify(outcome));
    if (outcome instanceof SharedProbeFailed) {
      return yield* Effect.fail(outcome);
    }
    return outcome;
  }),
).pipe(
  CliCommand.withDescription(
    "Run one shared NanoClaw, Effect, and OpenClaw conversation.",
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
    probeCommand,
  ]),
);

const cli = CliCommand.run(evaluationCommand, {
  name: "moltzap-evals",
  version: CLI_VERSION,
});

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- @effect/cli owns argv decoding at the process boundary.
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
