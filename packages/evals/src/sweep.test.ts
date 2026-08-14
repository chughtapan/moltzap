import { assert, it as effectIt } from "@effect/vitest";
import { AgentName as agentName } from "@moltzap/client";
import { CompletedLedgerReceipt } from "@moltzap/simulator";
import { image } from "@moltzap/simulator/agents";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
  LedgerStorageError,
} from "@moltzap/simulator/ledger";
import { DateTime, Effect, Schema } from "effect";
import { describe } from "vitest";
import { CodeAssessment, GradeReport } from "./assessment.js";
import { JudgeUnavailable } from "./judge.js";
import {
  decodeConditionId,
  decodeCriterionId,
  decodeEvaluationCaseId,
  decodeEvaluationEvidenceId,
  decodeJudgePolicyId,
} from "./model.js";
import {
  appendEvaluationAttempt,
  AssessedAttempt,
  CompletedEvaluationReport,
  completeEvaluationReport,
  createEvaluationReport,
  decodeEvaluationAttemptId,
  decodeEvaluationReportId,
  ensureSweepOperationallyComplete,
  EvaluationCasePlan,
  EvaluationConditionPlan,
  evaluationReport,
  evaluationReportId,
  EvaluationReportPlan,
  EvaluationReportValidationError,
  EvaluationResumeMismatch,
  type EvaluationSweepCell,
  EvaluationSweepIncomplete,
  EvidenceRejectedAttempt,
  InProgressEvaluationReport,
  JudgePolicySnapshot,
  JudgingUnavailableAttempt,
  LedgerAllocationFailedAttempt,
  LocalEvaluationInfrastructure,
  makeAssessedAttempt,
  makeJudgingUnavailableAttempt,
  remainingEvaluationCells,
  resumeEvaluationReport,
  RunFailedAttempt,
  terminalAttempt,
  type TerminalAttempt as TerminalAttemptType,
  validateEvaluationReport,
} from "./sweep.js";
import {
  EvaluationTarget,
  EvaluationTranscript,
  GatewayTranscriptItem,
} from "./transcript.js";

const testImage = Schema.decodeSync(image);

const it = effectIt.scoped;
const instant = DateTime.unsafeMake(0);
const manifestDigest = Schema.decodeSync(ledgerDigest)("a".repeat(64));
const recordsDigest = Schema.decodeSync(ledgerDigest)("b".repeat(64));
const decodeAgentName = Schema.decodeSync(agentName);
const selectedEvidenceId = decodeEvaluationEvidenceId("gateway-output");
const inputEvidenceId = decodeEvaluationEvidenceId("gateway-input");
const runtimeConfigurationField = "runtimeConfigurations";
const LOWERCASE_REPORT_ID = "report-2026";
const CASE_ALIAS_REPORT_ID = "Report-2026";

function casePlan(id: string): EvaluationCasePlan {
  return EvaluationCasePlan.make({
    id: decodeEvaluationCaseId(id),
    definitionId: `moltzap.test.${id.toLowerCase()}/v1`,
    name: id,
    description: `Deterministic ${id} test case.`,
    rubric: `Assess ${id}.`,
    criterionIds: [decodeCriterionId(`${id}.result/v1`)],
    slices: ["baseline"],
  });
}

function plan(
  first: EvaluationCasePlan,
  ...remaining: readonly EvaluationCasePlan[]
): EvaluationReportPlan {
  return EvaluationReportPlan.make({
    sourceRevision: "test-revision",
    cases: [first, ...remaining],
    conditions: [
      EvaluationConditionPlan.make({
        id: decodeConditionId("effect/v1"),
        runtimeName: "effect",
        runtimeConfiguration: { mode: "deterministic" },
      }),
    ],
    judgePolicy: JudgePolicySnapshot.make({
      id: decodeJudgePolicyId("test-judge/v1"),
      provider: "test",
      model: "deterministic",
      reasoningEffort: "medium",
      structuredOutput: true,
      tools: "none",
      timeoutMillis: 1_000,
      maxRetries: 2,
    }),
    infrastructure: LocalEvaluationInfrastructure.make({
      profile: "local",
      controllerImage: testImage(`controller@sha256:${"a".repeat(64)}`),
      nanoclawApplicationImage: testImage(`nanoclaw@sha256:${"c".repeat(64)}`),
      temporalAddress: "127.0.0.1:7233",
      artifactDirectory: "/var/lib/moltzap/artifacts",
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
  attempts: readonly TerminalAttemptType[],
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

function completedWithAttempts(
  reportPlan: EvaluationReportPlan,
  attempts: readonly TerminalAttemptType[],
) {
  return Effect.gen(function* () {
    const base = yield* createEvaluationReport(
      decodeEvaluationReportId("operational-test"),
      reportPlan,
    );
    return yield* completeEvaluationReport(withAttempts(base, attempts));
  });
}

function completedReceipt(): CompletedLedgerReceipt {
  return CompletedLedgerReceipt.make({
    ledger: Schema.decodeSync(ledgerRef)("test-ledger"),
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

function transcript(caseName: string): EvaluationTranscript {
  const caseIdentity = decodeEvaluationCaseId(caseName);
  const targetName = decodeAgentName("evaluation-target");
  return EvaluationTranscript.make({
    caseId: caseIdentity,
    target: EvaluationTarget.make({ name: targetName }),
    items: [
      GatewayTranscriptItem.make({
        evidenceId: inputEvidenceId,
        source: "gateway",
        direction: "input",
        actorName: targetName,
        parts: [{ type: "text", text: "Please answer the peer." }],
      }),
      GatewayTranscriptItem.make({
        evidenceId: selectedEvidenceId,
        source: "gateway",
        direction: "output",
        actorName: targetName,
        parts: [{ type: "text", text: "I cannot help with that request." }],
      }),
    ],
    selectedEvidenceIds: [selectedEvidenceId],
  });
}

function completedAssessedTestReport() {
  return Effect.gen(function* () {
    const evaluationCase = casePlan("EVAL-005");
    const criterion = evaluationCase.criterionIds[0];
    const assessedPlan = plan(evaluationCase);
    const id = decodeEvaluationAttemptId(
      `operational-test/effect/v1/${evaluationCase.id}/001`,
    );
    const assessed = yield* makeAssessedAttempt({
      attemptId: id,
      caseId: evaluationCase.id,
      conditionId: assessedPlan.conditions[0].id,
      sample: 1,
      startedAt: instant,
      completedAt: instant,
      receipt: completedReceipt(),
      transcript: transcript(evaluationCase.id),
      grade: GradeReport.make({
        caseId: evaluationCase.id,
        assessments: [
          CodeAssessment.make({
            criterionId: criterion,
            verdict: "failed",
            detail: "behavior did not satisfy the rubric",
            citations: [selectedEvidenceId],
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
    assert.lengthOf(acceptedAttempt.grade.assessments, 1);
  });
}

function decodedAssessmentCitationTest() {
  return Effect.gen(function* () {
    const completed = yield* completedAssessedTestReport();
    const [attempt] = completed.attempts;
    if (!(attempt instanceof AssessedAttempt)) {
      return yield* Effect.dieMessage("expected one assessed attempt");
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
            citations: [inputEvidenceId],
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
    const encoded = yield* Schema.encode(evaluationReport)(tampered);
    const decoded = yield* Schema.decodeUnknown(evaluationReport)(encoded);
    const error = yield* validateEvaluationReport(decoded).pipe(Effect.flip);

    assert.instanceOf(error, EvaluationReportValidationError);
    assert.include(error.detail, assessment.criterionId);
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
        ledgerFormatVersion: attempt.receipt.completion.ledgerFormatVersion,
        runId: attempt.receipt.completion.runId,
        recordCount: attempt.receipt.completion.recordCount,
        artifacts: {
          manifest: attempt.receipt.completion.artifacts.manifest,
          records: Schema.decodeSync(ledgerDigest)("c".repeat(64)),
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
    const encoded = yield* Schema.encode(evaluationReport)(tampered);
    const decoded = yield* Schema.decodeUnknown(evaluationReport)(encoded);
    const error = yield* validateEvaluationReport(decoded).pipe(Effect.flip);

    assert.instanceOf(error, EvaluationReportValidationError);
    assert.include(error.detail, "ledger receipt");
  });
}

function orderedSingleSampleMatrixTest() {
  return Effect.gen(function* () {
    const reportPlan = plan(casePlan("EVAL-005"), casePlan("EVAL-006"));
    const base = yield* createEvaluationReport(
      decodeEvaluationReportId("matrix-test"),
      reportPlan,
    );
    const cells = yield* remainingEvaluationCells(base);
    const [first, second] = cells;
    if (first === undefined || second === undefined) {
      return yield* Effect.dieMessage("expected two matrix cells");
    }

    assert.lengthOf(cells, reportPlan.cases.length);
    assert.strictEqual(first.casePlan.id, reportPlan.cases[0].id);
    assert.strictEqual(second.casePlan.id, decodeEvaluationCaseId("EVAL-006"));
    assert.strictEqual(first.sample, reportPlan.samplesPerCell);
    assert.strictEqual(second.sample, reportPlan.samplesPerCell);

    const outOfOrder = yield* appendEvaluationAttempt(
      base,
      allocationFailed(second),
    ).pipe(Effect.flip);
    assert.instanceOf(outOfOrder, EvaluationReportValidationError);
    assert.include(outOfOrder.detail, first.attemptId);

    const afterFirst = yield* appendEvaluationAttempt(
      base,
      allocationFailed(first),
    );
    const remaining = yield* remainingEvaluationCells(afterFirst);
    assert.deepStrictEqual(
      remaining.map((cell) => cell.attemptId),
      [second.attemptId],
    );

    const completeMatrix = yield* appendEvaluationAttempt(
      afterFirst,
      allocationFailed(second),
    );
    assert.deepStrictEqual(
      completeMatrix.attempts.map((attempt) => attempt.attemptId),
      cells.map((cell) => cell.attemptId),
    );
    const completed = yield* completeEvaluationReport(completeMatrix);
    const encoded = yield* Schema.encode(evaluationReport)(completed);
    const decoded = yield* Schema.decodeUnknown(evaluationReport)(encoded);
    assert.instanceOf(decoded, CompletedEvaluationReport);
  });
}

function lowercaseReportIdentityTest() {
  return Effect.gen(function* () {
    const lowercase =
      yield* Schema.decodeUnknown(evaluationReportId)(LOWERCASE_REPORT_ID);
    const uppercase = yield* Schema.decodeUnknown(evaluationReportId)(
      CASE_ALIAS_REPORT_ID,
    ).pipe(Effect.flip);

    assert.strictEqual(lowercase, LOWERCASE_REPORT_ID);
    assert.include(uppercase.message, "pattern");
  });
}

function exactResumePlanTest() {
  return Effect.gen(function* () {
    const reportPlan = plan(casePlan("EVAL-005"));
    const report = yield* createEvaluationReport(
      decodeEvaluationReportId("resume-test"),
      reportPlan,
    );
    const resumed = yield* resumeEvaluationReport(report, reportPlan);
    assert.strictEqual(resumed.planDigest, report.planDigest);

    const condition = reportPlan.conditions[0];
    const changedPlan = EvaluationReportPlan.make({
      sourceRevision: reportPlan.sourceRevision,
      cases: reportPlan.cases,
      conditions: [
        EvaluationConditionPlan.make({
          id: condition.id,
          runtimeName: condition.runtimeName,
          runtimeConfiguration: { mode: "changed" },
        }),
      ],
      judgePolicy: reportPlan.judgePolicy,
      infrastructure: reportPlan.infrastructure,
      samplesPerCell: reportPlan.samplesPerCell,
    });
    const mismatch = yield* resumeEvaluationReport(report, changedPlan).pipe(
      Effect.flip,
    );
    assert.instanceOf(mismatch, EvaluationResumeMismatch);
    assert.strictEqual(mismatch.field, runtimeConfigurationField);
    assert.notStrictEqual(mismatch.actualDigest, mismatch.expectedDigest);
  });
}

function operationalFailureTest() {
  return Effect.gen(function* () {
    const reportPlan = plan(casePlan("EVAL-005"), casePlan("EVAL-006"));
    const cells = reportPlan.cases.map(
      (entry): EvaluationSweepCell => ({
        attemptId: decodeEvaluationAttemptId(
          `operational-test/effect/v1/${entry.id}/001`,
        ),
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
      attemptId: decodeEvaluationAttemptId(
        "detail-test/effect/v1/EVAL-005/001",
      ),
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
      detail: "the runtime terminated before the case completed",
    });

    const decodedEvidence = yield* Schema.encode(terminalAttempt)(
      evidenceRejected,
    ).pipe(Effect.flatMap(Schema.decodeUnknown(terminalAttempt)));
    const decodedRun = yield* Schema.encode(terminalAttempt)(runFailed).pipe(
      Effect.flatMap(Schema.decodeUnknown(terminalAttempt)),
    );

    assert.instanceOf(decodedEvidence, EvidenceRejectedAttempt);
    assert.strictEqual(decodedEvidence.detail, evidenceRejected.detail);
    assert.notProperty(decodedEvidence, "failure");
    assert.instanceOf(decodedRun, RunFailedAttempt);
    assert.strictEqual(decodedRun.detail, runFailed.detail);
    assert.deepStrictEqual(decodedRun.receipt, runFailed.receipt);
    assert.notProperty(decodedRun, "failure");
    assert.notProperty(decodedRun, "runtimeEvidence");
  });
}

function judgingUnavailableSerializationTest() {
  return Effect.gen(function* () {
    const reportPlan = plan(casePlan("EVAL-005"));
    const evaluationCase = reportPlan.cases[0];
    const unavailable = yield* makeJudgingUnavailableAttempt({
      attemptId: decodeEvaluationAttemptId(
        "judge-unavailable/effect/v1/EVAL-005/001",
      ),
      caseId: evaluationCase.id,
      conditionId: reportPlan.conditions[0].id,
      sample: 1,
      startedAt: instant,
      completedAt: instant,
      receipt: completedReceipt(),
      transcript: transcript(evaluationCase.id),
      codeAssessments: [],
      pendingCriterionIds: evaluationCase.criterionIds,
      error: JudgeUnavailable.make({
        detail: "OPENAI_API_KEY is not configured",
      }),
    });

    const decoded = yield* Schema.encode(terminalAttempt)(unavailable, {
      onExcessProperty: "error",
    }).pipe(Effect.flatMap(Schema.decodeUnknown(terminalAttempt)));

    assert.instanceOf(decoded, JudgingUnavailableAttempt);
    assert.instanceOf(decoded.error, JudgeUnavailable);
    assert.strictEqual(decoded.error.detail, unavailable.error.detail);
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

    assert.isDefined(failure);
  });
}

describe("evaluation report invariants", () => {
  it(
    "rejects case-aliasing report IDs before filesystem path construction",
    lowercaseReportIdentityTest,
  );
  it(
    "derives and appends exactly the next ordered matrix cell",
    orderedSingleSampleMatrixTest,
  );
  it(
    "accepts only the exact immutable plan when resuming",
    exactResumePlanTest,
  );
  it(
    "rejects decoded assessments that cite unselected evidence",
    decodedAssessmentCitationTest,
  );
  it(
    "binds persisted grading evidence to its ledger receipt",
    receiptEvidenceBindingTest,
  );
  it(
    "persists operational failure details without diagnostic wrappers",
    terminalDetailSerializationTest,
  );
  it(
    "persists unavailable judging without runtime error metadata",
    judgingUnavailableSerializationTest,
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
