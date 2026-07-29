import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { assert, it as effectIt } from "@effect/vitest";
import { CompletedLedgerReceipt } from "@moltzap/simulator";
import {
  LedgerCompletion,
  LedgerDigest,
  LedgerRef,
  LedgerStorageError,
} from "@moltzap/simulator/ledger";
import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import { describe } from "vitest";
import {
  ConditionId,
  CriterionId,
  EvaluationCaseId,
  JudgePolicyId,
} from "./cases.js";
import {
  CodeAssessment,
  GradeReport,
  semanticJudgeCalibrationFixtures,
} from "./grading.js";
import { RuntimeTerminationEvidenceRead } from "./events.js";
import {
  AssessedAttempt,
  CompletedEvaluationReport,
  EvidenceRejectedAttempt,
  EvaluationAttemptId,
  EvaluationCasePlan,
  EvaluationConditionPlan,
  EvaluationReport,
  EvaluationReportId,
  EvaluationReportPlan,
  EvaluationReportValidationError,
  EvaluationResumeMismatch,
  EvaluationSweepIncomplete,
  InProgressEvaluationReport,
  JudgePolicySnapshot,
  LedgerAllocationFailedAttempt,
  RunFailedAttempt,
  TerminalAttempt,
  checkpointEvaluationReport,
  completeEvaluationReport,
  createEvaluationReport,
  ensureSweepOperationallyComplete,
  loadEvaluationReport,
  makeAssessedAttempt,
  makeEvaluationAttemptId,
  resumeEvaluationReport,
  runEvaluationSweep,
  validateEvaluationReport,
  type EvaluationSweepCell,
  type TerminalAttempt as TerminalAttemptType,
} from "./sweep.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function -- regression assertions pin durable resume, evidence integrity, and CLI exit semantics. */

const it = effectIt.scoped;
const caseId = Schema.decodeSync(EvaluationCaseId);
const conditionId = Schema.decodeSync(ConditionId);
const criterionId = Schema.decodeSync(CriterionId);
const judgePolicyId = Schema.decodeSync(JudgePolicyId);
const reportId = Schema.decodeSync(EvaluationReportId);
const attemptId = Schema.decodeSync(EvaluationAttemptId);
const instant = DateTime.unsafeMake(0);
const manifestDigest = Schema.decodeSync(LedgerDigest)("a".repeat(64));
const recordsDigest = Schema.decodeSync(LedgerDigest)("b".repeat(64));

class DeliberateExecutionFailure extends Schema.TaggedError<DeliberateExecutionFailure>()(
  "DeliberateExecutionFailure",
  {
    detail: Schema.NonEmptyString,
  },
) {}

function casePlan(id: string): EvaluationCasePlan {
  return EvaluationCasePlan.make({
    id: caseId(id),
    definitionId: `moltzap.test.${id.toLowerCase()}/v1`,
    name: id,
    description: `Deterministic ${id} test case.`,
    rubric: `Assess ${id}.`,
    criterionIds: [criterionId(`${id}.result/v1`)],
    slices: ["baseline"],
  });
}

function plan(
  first: EvaluationCasePlan,
  ...remaining: ReadonlyArray<EvaluationCasePlan>
): EvaluationReportPlan {
  return EvaluationReportPlan.make({
    sourceRevision: "test-revision",
    cases: [first, ...remaining],
    conditions: [
      EvaluationConditionPlan.make({
        id: conditionId("effect/v1"),
        runtimeName: "effect",
        runtimeConfiguration: { mode: "deterministic" },
      }),
    ],
    judgePolicy: JudgePolicySnapshot.make({
      id: judgePolicyId("test-judge/v1"),
      provider: "test",
      model: "deterministic",
      reasoningEffort: "medium",
      structuredOutput: true,
      tools: "none",
      timeoutMillis: 1_000,
      maxRetries: 2,
    }),
    samplesPerCell: 1,
  });
}

function allocationFailed(
  cell: EvaluationSweepCell,
): LedgerAllocationFailedAttempt {
  return LedgerAllocationFailedAttempt.make({
    attemptId: cell.attemptId,
    caseId: cell.casePlan.id,
    conditionId: cell.conditionPlan.id,
    sample: cell.sample,
    startedAt: instant,
    completedAt: instant,
    failure: LedgerStorageError.make({
      operation: "allocate",
      detail: "deterministic test failure",
    }),
  });
}

function withAttempts(
  report: InProgressEvaluationReport,
  attempts: ReadonlyArray<TerminalAttemptType>,
): InProgressEvaluationReport {
  return InProgressEvaluationReport.make({
    formatVersion: report.formatVersion,
    reportId: report.reportId,
    planDigest: report.planDigest,
    plan: report.plan,
    createdAt: report.createdAt,
    updatedAt: instant,
    attempts,
  });
}

function checkpointResumeTest() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-evals-sweep-",
    });
    const reportPath = path.join(directory, "report.json");
    const reportPlan = plan(casePlan("EVAL-005"), casePlan("EVAL-006"));
    const base = yield* createEvaluationReport(
      reportId("resume-test"),
      reportPlan,
    );
    const firstId = yield* makeEvaluationAttemptId(
      base.reportId,
      base.plan.conditions[0].id,
      base.plan.cases[0].id,
    );
    const first = allocationFailed({
      attemptId: firstId,
      casePlan: base.plan.cases[0],
      conditionPlan: base.plan.conditions[0],
      sample: 1,
    });
    yield* checkpointEvaluationReport(reportPath, withAttempts(base, [first]));
    const resumed = yield* resumeEvaluationReport(reportPath, reportPlan);
    const executed: Array<EvaluationAttemptId> = [];
    const completed = yield* runEvaluationSweep(reportPath, resumed, (cell) =>
      Effect.sync(() => {
        executed.push(cell.attemptId);
        return allocationFailed(cell);
      }),
    );
    const persisted = yield* loadEvaluationReport(reportPath);

    assert.deepStrictEqual(executed, [
      attemptId("resume-test/effect/v1/EVAL-006/001"),
    ]);
    const retained = completed.attempts[0];
    assert.strictEqual(retained?.attemptId, first.attemptId);
    assert.strictEqual(retained?._tag, first._tag);
    assert.strictEqual(persisted._tag, "CompletedEvaluationReport");
    const persistedFirst = persisted.attempts[0];
    if (!(persistedFirst instanceof LedgerAllocationFailedAttempt)) {
      return yield* Effect.dieMessage(
        "expected the persisted ledger allocation failure",
      );
    }
    assert.instanceOf(persistedFirst.failure, LedgerStorageError);
    assert.strictEqual(persistedFirst.failure.operation, "allocate");
    assert.deepStrictEqual(
      persisted.attempts.map((attempt) => attempt.attemptId),
      [
        attemptId("resume-test/effect/v1/EVAL-005/001"),
        attemptId("resume-test/effect/v1/EVAL-006/001"),
      ],
    );
  }).pipe(Effect.provide(NodeContext.layer));
}

function resumeMismatchTest() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-evals-resume-mismatch-",
    });
    const reportPath = path.join(directory, "report.json");
    const reportPlan = plan(casePlan("EVAL-005"));
    const base = yield* createEvaluationReport(
      reportId("resume-mismatch-test"),
      reportPlan,
    );
    yield* checkpointEvaluationReport(reportPath, base);
    const changedPlan = EvaluationReportPlan.make({
      ...reportPlan,
      conditions: [
        EvaluationConditionPlan.make({
          ...reportPlan.conditions[0],
          runtimeConfiguration: { mode: "changed" },
        }),
      ],
    });
    const mismatch = yield* resumeEvaluationReport(
      reportPath,
      changedPlan,
    ).pipe(Effect.flip);

    assert.instanceOf(mismatch, EvaluationResumeMismatch);
    assert.strictEqual(mismatch.field, "runtimeConfigurations");
  }).pipe(Effect.provide(NodeContext.layer));
}

function executionFailureFixture(prefix: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    const reportPath = path.join(directory, "report.json");
    const base = yield* createEvaluationReport(
      reportId(`${prefix}report`),
      plan(casePlan("EVAL-005")),
    );
    return { base, fileSystem, reportPath };
  });
}

function callbackFailurePropagationTest() {
  return Effect.gen(function* () {
    const { base, fileSystem, reportPath } =
      yield* executionFailureFixture("callback-failure-");
    const expected = DeliberateExecutionFailure.make({
      detail: "deliberate callback failure",
    });
    const failure = yield* runEvaluationSweep(reportPath, base, () =>
      Effect.fail(expected),
    ).pipe(Effect.flip);

    if (!(failure instanceof DeliberateExecutionFailure)) {
      return yield* Effect.dieMessage(
        "expected the callback's typed execution failure",
      );
    }
    assert.strictEqual(failure.detail, expected.detail);
    assert.lengthOf(base.attempts, 0);
    assert.isFalse(yield* fileSystem.exists(reportPath));
  }).pipe(Effect.provide(NodeContext.layer));
}

function callbackDefectPropagationTest() {
  return Effect.gen(function* () {
    const { base, fileSystem, reportPath } =
      yield* executionFailureFixture("callback-defect-");
    const exit = yield* runEvaluationSweep(reportPath, base, () =>
      Effect.dieMessage("deliberate callback defect"),
    ).pipe(Effect.exit);

    assert.isTrue(
      Exit.isFailure(exit) && Option.isSome(Cause.dieOption(exit.cause)),
    );
    assert.lengthOf(base.attempts, 0);
    assert.isFalse(yield* fileSystem.exists(reportPath));
  }).pipe(Effect.provide(NodeContext.layer));
}

function callbackInterruptionPropagationTest() {
  return Effect.gen(function* () {
    const { base, fileSystem, reportPath } = yield* executionFailureFixture(
      "callback-interrupt-",
    );
    const exit = yield* runEvaluationSweep(
      reportPath,
      base,
      () => Effect.interrupt,
    ).pipe(Effect.exit);

    assert.isTrue(Exit.isInterrupted(exit));
    assert.lengthOf(base.attempts, 0);
    assert.isFalse(yield* fileSystem.exists(reportPath));
  }).pipe(Effect.provide(NodeContext.layer));
}

function completedWithAttempts(
  reportPlan: EvaluationReportPlan,
  attempts: ReadonlyArray<TerminalAttemptType>,
) {
  return Effect.gen(function* () {
    const base = yield* createEvaluationReport(
      reportId("operational-test"),
      reportPlan,
    );
    return yield* completeEvaluationReport(withAttempts(base, attempts));
  });
}

function completedReceipt(): CompletedLedgerReceipt {
  return CompletedLedgerReceipt.make({
    ledger: Schema.decodeSync(LedgerRef)("test-ledger"),
    completion: LedgerCompletion.make({
      ledgerFormatVersion: 1,
      runId: "test-run",
      recordCount: 100,
      artifacts: {
        manifest: manifestDigest,
        records: recordsDigest,
      },
    }),
  });
}

function firstCalibrationFixture() {
  return semanticJudgeCalibrationFixtures().pipe(
    Effect.map(([fixture]) => fixture),
  );
}

function completedAssessedTestReport() {
  return Effect.gen(function* () {
    const fixture = yield* firstCalibrationFixture();
    const criterion = fixture.bundle.criteria[0].id;
    const assessedPlan = plan(
      EvaluationCasePlan.make({
        ...casePlan(fixture.bundle.caseId),
        criterionIds: [criterion],
      }),
    );
    const id = attemptId(
      `operational-test/effect/v1/${fixture.bundle.caseId}/001`,
    );
    const assessed = yield* makeAssessedAttempt({
      attemptId: id,
      caseId: fixture.bundle.caseId,
      conditionId: assessedPlan.conditions[0].id,
      sample: 1,
      startedAt: instant,
      completedAt: instant,
      receipt: completedReceipt(),
      transcript: fixture.bundle.transcript,
      grade: GradeReport.make({
        caseId: fixture.bundle.caseId,
        assessments: [
          CodeAssessment.make({
            criterionId: criterion,
            verdict: "failed",
            detail: "behavior did not satisfy the rubric",
            citations: [fixture.bundle.transcript.selectedResponseIds[0]],
          }),
        ],
      }),
    });
    return yield* completedWithAttempts(assessedPlan, [assessed]);
  });
}

function assessedFailureTest() {
  return Effect.gen(function* () {
    const completed = yield* completedAssessedTestReport();
    const accepted = yield* ensureSweepOperationallyComplete(completed);
    const acceptedAttempt = accepted.attempts[0];
    if (!(acceptedAttempt instanceof AssessedAttempt)) {
      return yield* Effect.dieMessage("expected one assessed attempt");
    }
    assert.strictEqual(acceptedAttempt.grade.verdict, "failed");
  });
}

function decodedAssessmentCitationTest() {
  return Effect.gen(function* () {
    const completed = yield* completedAssessedTestReport();
    const [attempt] = completed.attempts;
    if (!(attempt instanceof AssessedAttempt)) {
      return yield* Effect.dieMessage("expected one assessed attempt");
    }
    const selected = new Set(attempt.transcript.selectedResponseIds);
    const prompt = attempt.transcript.conversations
      .flatMap((conversation) => conversation.messages)
      .find((message) => !selected.has(message.messageId));
    if (prompt === undefined) {
      return yield* Effect.dieMessage("expected an unselected prompt");
    }
    const assessment = attempt.grade.assessments[0];
    const tamperedAttempt = AssessedAttempt.make({
      attemptId: attempt.attemptId,
      caseId: attempt.caseId,
      conditionId: attempt.conditionId,
      sample: attempt.sample,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      receipt: attempt.receipt,
      transcript: attempt.transcript,
      grade: GradeReport.make({
        caseId: attempt.grade.caseId,
        assessments: [
          CodeAssessment.make({
            criterionId: assessment.criterionId,
            verdict: "failed",
            detail: "citation was replaced after grading",
            citations: [prompt.messageId],
          }),
        ],
      }),
      evidenceDigest: attempt.evidenceDigest,
    });
    const tampered = CompletedEvaluationReport.make({
      formatVersion: completed.formatVersion,
      reportId: completed.reportId,
      planDigest: completed.planDigest,
      plan: completed.plan,
      createdAt: completed.createdAt,
      updatedAt: completed.updatedAt,
      completedAt: completed.completedAt,
      attempts: [tamperedAttempt],
    });
    const encoded = yield* Schema.encode(EvaluationReport)(tampered);
    const decoded = yield* Schema.decodeUnknown(EvaluationReport)(encoded);
    const error = yield* validateEvaluationReport(decoded).pipe(Effect.flip);

    assert.instanceOf(error, EvaluationReportValidationError);
    assert.include(error.detail, "selected target response");
  });
}

function receiptEvidenceBindingTest() {
  return Effect.gen(function* () {
    const completed = yield* completedAssessedTestReport();
    const [attempt] = completed.attempts;
    if (!(attempt instanceof AssessedAttempt)) {
      return yield* Effect.dieMessage("expected one assessed attempt");
    }
    const changedReceipt = CompletedLedgerReceipt.make({
      ledger: attempt.receipt.ledger,
      completion: LedgerCompletion.make({
        ...attempt.receipt.completion,
        artifacts: {
          ...attempt.receipt.completion.artifacts,
          records: Schema.decodeSync(LedgerDigest)("c".repeat(64)),
        },
      }),
    });
    const tamperedAttempt = AssessedAttempt.make({
      attemptId: attempt.attemptId,
      caseId: attempt.caseId,
      conditionId: attempt.conditionId,
      sample: attempt.sample,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      receipt: changedReceipt,
      transcript: attempt.transcript,
      grade: attempt.grade,
      evidenceDigest: attempt.evidenceDigest,
    });
    const tampered = CompletedEvaluationReport.make({
      formatVersion: completed.formatVersion,
      reportId: completed.reportId,
      planDigest: completed.planDigest,
      plan: completed.plan,
      createdAt: completed.createdAt,
      updatedAt: completed.updatedAt,
      completedAt: completed.completedAt,
      attempts: [tamperedAttempt],
    });
    const encoded = yield* Schema.encode(EvaluationReport)(tampered);
    const decoded = yield* Schema.decodeUnknown(EvaluationReport)(encoded);
    const error = yield* validateEvaluationReport(decoded).pipe(Effect.flip);

    assert.instanceOf(error, EvaluationReportValidationError);
    assert.include(error.detail, "ledger receipt");
  });
}

function operationalFailureTest() {
  return Effect.gen(function* () {
    const reportPlan = plan(casePlan("EVAL-005"), casePlan("EVAL-006"));
    const cells = reportPlan.cases.map(
      (entry): EvaluationSweepCell => ({
        attemptId: attemptId(`operational-test/effect/v1/${entry.id}/001`),
        casePlan: entry,
        conditionPlan: reportPlan.conditions[0],
        sample: 1,
      }),
    );
    const completed = yield* completedWithAttempts(
      reportPlan,
      cells.map(allocationFailed),
    );
    const incomplete = yield* ensureSweepOperationallyComplete(completed).pipe(
      Effect.flip,
    );

    assert.instanceOf(incomplete, EvaluationSweepIncomplete);
    assert.deepStrictEqual(
      [...incomplete.attemptIds],
      cells.map((cell) => cell.attemptId),
    );
  });
}

function terminalDetailSerializationTest() {
  return Effect.gen(function* () {
    const reportPlan = plan(casePlan("EVAL-005"));
    const common = {
      attemptId: attemptId("detail-test/effect/v1/EVAL-005/001"),
      caseId: reportPlan.cases[0].id,
      conditionId: reportPlan.conditions[0].id,
      sample: 1 as const,
      startedAt: instant,
      completedAt: instant,
    };
    const evidenceRejected = EvidenceRejectedAttempt.make({
      ...common,
      receipt: completedReceipt(),
      detail: "the ledger evidence did not satisfy the case contract",
    });
    const runFailed = RunFailedAttempt.make({
      ...common,
      receipt: completedReceipt(),
      detail: "the runtime terminated before the episode completed",
      runtimeEvidence: RuntimeTerminationEvidenceRead.make({
        observations: [],
      }),
    });

    const decodedEvidence = yield* Schema.encode(TerminalAttempt)(
      evidenceRejected,
    ).pipe(Effect.flatMap(Schema.decodeUnknown(TerminalAttempt)));
    const decodedRun = yield* Schema.encode(TerminalAttempt)(runFailed).pipe(
      Effect.flatMap(Schema.decodeUnknown(TerminalAttempt)),
    );

    assert.instanceOf(decodedEvidence, EvidenceRejectedAttempt);
    assert.strictEqual(
      decodedEvidence.detail,
      "the ledger evidence did not satisfy the case contract",
    );
    assert.notProperty(decodedEvidence, "failure");
    assert.instanceOf(decodedRun, RunFailedAttempt);
    assert.strictEqual(
      decodedRun.detail,
      "the runtime terminated before the episode completed",
    );
    assert.notProperty(decodedRun, "failure");
  });
}

function canonicalSliceValidationTest() {
  return Effect.gen(function* () {
    const reportPlan = plan(casePlan("EVAL-005"));
    const encoded = yield* Schema.encode(EvaluationReportPlan)(reportPlan);
    const failure = yield* Schema.decodeUnknown(EvaluationReportPlan)({
      ...encoded,
      cases: [
        {
          ...encoded.cases[0],
          slices: ["customer-invented-slice"],
        },
      ],
    }).pipe(Effect.flip);

    assert.strictEqual(failure._tag, "ParseError");
  });
}

describe("evaluation sweep durability", () => {
  it(
    "resumes a checkpoint without rerunning its terminal cells",
    checkpointResumeTest,
  );
  it(
    "rejects a resume when immutable runtime configuration changed",
    resumeMismatchTest,
  );
  it(
    "rejects decoded assessments that cite an unselected prompt",
    decodedAssessmentCitationTest,
  );
  it(
    "binds persisted grading evidence to its ledger receipt",
    receiptEvidenceBindingTest,
  );
  it(
    "propagates callback failures without recording a terminal attempt",
    callbackFailurePropagationTest,
  );
  it(
    "propagates callback defects without recording a terminal attempt",
    callbackDefectPropagationTest,
  );
  it(
    "propagates callback interruption without recording a terminal attempt",
    callbackInterruptionPropagationTest,
  );
  it(
    "persists operational failure details without diagnostic wrappers",
    terminalDetailSerializationTest,
  );
  it(
    "rejects report plans outside the canonical slice vocabulary",
    canonicalSliceValidationTest,
  );
});

describe("evaluation sweep exit semantics", () => {
  it(
    "accepts an assessed behavioral failure as operationally complete",
    assessedFailureTest,
  );
  it(
    "reports every operationally incomplete attempt in matrix order",
    operationalFailureTest,
  );
});
