import { assert, describe, it } from "@effect/vitest";
import { CompletedLedgerReceipt } from "@moltzap/simulator";
import {
  LedgerCompletion,
  LedgerDigest,
  LedgerRef,
  LedgerStorageError,
} from "@moltzap/simulator/ledger";
import { DateTime, Effect, Schema } from "effect";
import {
  ConditionId,
  CriterionId,
  EvaluationCaseId,
  JudgePolicyId,
} from "./cases.js";
import {
  PhoenixPublicationConflict,
  phoenixCatalogExamples,
  phoenixAttemptEvaluations,
  phoenixExperimentProvenance,
  reconcilePhoenixDatasetCatalog,
  type PhoenixDatasetCatalog,
} from "./phoenix.js";
import {
  EvaluationCasePlan,
  EvaluationConditionPlan,
  EvaluationAttemptId,
  EvaluationReportDigest,
  EvaluationReportPlan,
  EvidenceRejectedAttempt,
  JudgePolicySnapshot,
  LedgerAllocationFailedAttempt,
} from "./sweep.js";

const DATASET_NAME = "moltzap-evaluations";
const DATASET_DESCRIPTION =
  "MoltZap code-first behavioral evaluation cases (schema v1).";
const caseId = Schema.decodeSync(EvaluationCaseId);
const conditionId = Schema.decodeSync(ConditionId);
const criterionId = Schema.decodeSync(CriterionId);
const judgePolicyId = Schema.decodeSync(JudgePolicyId);
const attemptId = Schema.decodeSync(EvaluationAttemptId);
const reportDigest = Schema.decodeSync(EvaluationReportDigest);
const ledgerRef = Schema.decodeSync(LedgerRef);
const ledgerDigest = Schema.decodeSync(LedgerDigest);

function completedReceipt(): CompletedLedgerReceipt {
  return CompletedLedgerReceipt.make({
    ledger: ledgerRef("phoenix-test-ledger"),
    completion: LedgerCompletion.make({
      ledgerFormatVersion: 1,
      runId: "phoenix-test-run",
      recordCount: 1,
      artifacts: {
        manifest: ledgerDigest("a".repeat(64)),
        records: ledgerDigest("b".repeat(64)),
      },
    }),
  });
}

function plan(): EvaluationReportPlan {
  return EvaluationReportPlan.make({
    sourceRevision: "phoenix-test-revision",
    cases: [
      EvaluationCasePlan.make({
        id: caseId("EVAL-005"),
        definitionId: "moltzap.test.phoenix/v1",
        name: "Phoenix reconciliation",
        description: "A deterministic Phoenix catalog fixture.",
        rubric: "Preserve the exact case catalog.",
        criterionIds: [criterionId("EVAL-005.result/v1")],
        slices: ["privacy", "baseline"],
      }),
    ],
    conditions: [
      EvaluationConditionPlan.make({
        id: conditionId("openclaw/v1"),
        runtimeName: "openclaw",
        runtimeConfiguration: {
          modelOverride: "provider/runtime-model",
          nativePolicy: {
            install: "workspace",
            flags: ["preserve", "verbatim"],
          },
        },
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

function catalogFixture() {
  return Effect.gen(function* () {
    const reportPlan = plan();
    const example = phoenixCatalogExamples(reportPlan)[0];
    if (example === undefined) {
      return yield* Effect.dieMessage("test catalog must contain one example");
    }
    const dataset: PhoenixDatasetCatalog = {
      name: DATASET_NAME,
      description: DATASET_DESCRIPTION,
      examples: [{ ...example, splits: ["privacy", "baseline"] }],
    };
    return { reportPlan, example, dataset };
  });
}

describe("Phoenix catalog reconciliation", () => {
  it("sorts case slices into stable metadata and split projections", () => {
    const examples = phoenixCatalogExamples(plan());

    assert.lengthOf(examples, 1);
    assert.deepStrictEqual(
      examples.flatMap((example) => example.splits),
      ["baseline", "privacy"],
    );
  });

  it.effect("accepts equivalent remote split ordering", () =>
    Effect.gen(function* () {
      const { dataset, reportPlan } = yield* catalogFixture();

      yield* reconcilePhoenixDatasetCatalog(dataset, reportPlan);
    }),
  );

  it.effect("rejects remote example drift under the stable dataset name", () =>
    Effect.gen(function* () {
      const { dataset, example, reportPlan } = yield* catalogFixture();
      const failure = yield* reconcilePhoenixDatasetCatalog(
        {
          ...dataset,
          examples: [
            {
              ...example,
              input: { ...example.input, rubric: "remote drift" },
            },
          ],
        },
        reportPlan,
      ).pipe(Effect.flip);

      assert.instanceOf(failure, PhoenixPublicationConflict);
      assert.include(failure.detail, "remote examples differ");
    }),
  );
});

// @agent-code-guard/regression-only: the publisher must expose the exact immutable execution inputs in the Phoenix comparison surface
describe("Phoenix experiment provenance", () => {
  it.effect("exposes native runtime and judge metadata", () =>
    Effect.gen(function* () {
      const reportPlan = plan();
      const provenance = yield* phoenixExperimentProvenance(
        reportPlan,
        reportPlan.conditions[0],
      );

      assert.deepStrictEqual(provenance, {
        runtimeConfiguration: {
          modelOverride: "provider/runtime-model",
          nativePolicy: {
            install: "workspace",
            flags: ["preserve", "verbatim"],
          },
        },
        judgePolicy: {
          id: "test-judge/v1",
          provider: "test",
          model: "deterministic",
          reasoningEffort: "medium",
          structuredOutput: true,
          tools: "none",
          timeoutMillis: 1_000,
          maxRetries: 2,
        },
      });
    }),
  );
});

describe("Phoenix operational attempts", () => {
  it("retains ledger allocation failures as run data without assessments", () => {
    const reportPlan = plan();
    const condition = reportPlan.conditions[0];
    const attempt = LedgerAllocationFailedAttempt.make({
      attemptId: attemptId("phoenix/openclaw/v1/EVAL-005/001"),
      caseId: reportPlan.cases[0].id,
      conditionId: condition.id,
      sample: 1,
      startedAt: DateTime.unsafeMake(0),
      completedAt: DateTime.unsafeMake(1),
      failure: LedgerStorageError.make({
        operation: "allocate",
        detail: "cannot create the ledger directory",
      }),
    });

    assert.deepStrictEqual(
      phoenixAttemptEvaluations(
        attempt,
        reportDigest("d".repeat(64)),
        condition,
      ),
      [],
    );
  });
});

describe("Phoenix evidence assessments", () => {
  it("publishes evidence rejection details without diagnostic vocabulary", () => {
    const reportPlan = plan();
    const condition = reportPlan.conditions[0];
    const attempt = EvidenceRejectedAttempt.make({
      attemptId: attemptId("phoenix/openclaw/v1/EVAL-005/001"),
      caseId: reportPlan.cases[0].id,
      conditionId: condition.id,
      sample: 1,
      startedAt: DateTime.unsafeMake(0),
      completedAt: DateTime.unsafeMake(1),
      receipt: completedReceipt(),
      detail: "the retained evidence is incomplete",
    });

    assert.deepStrictEqual(
      phoenixAttemptEvaluations(
        attempt,
        reportDigest("d".repeat(64)),
        condition,
      ),
      [
        {
          name: "moltzap.evidence",
          annotatorKind: "CODE",
          result: null,
          error: "the retained evidence is incomplete",
          metadata: {
            source: "code",
            reportDigest: "d".repeat(64),
            conditionId: "openclaw/v1",
          },
        },
      ],
    );
  });
});
