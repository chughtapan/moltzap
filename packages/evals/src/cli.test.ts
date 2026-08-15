/** @file CLI diagnostics preserve exact operator-facing failure distinctions. */

import { assert, effect, it } from "@effect/vitest";
import { IncompleteLedgerReceipt } from "@moltzap/simulator";
import { ledgerRef } from "@moltzap/simulator/ledger";
import { DateTime, Effect, Schema } from "effect";
import { evaluationCase } from "./cases.js";
import {
  type AttemptContext,
  type EvaluationImageKey,
  infrastructureFailed,
  invalidImageDetail,
  missingImageDetail,
} from "./cli.js";
import {
  decodeConditionId,
  decodeCriterionId,
  decodeEvaluationCaseId,
} from "./model.js";
import {
  decodeEvaluationAttemptId,
  EvaluationCasePlan,
  EvaluationConditionPlan,
} from "./sweep.js";

const CASE_ID = decodeEvaluationCaseId("EVAL-019");
const DIAGNOSTIC =
  "controller Job failed\nBackoffLimitExceeded: Job has reached the backoff limit";

// The real bundled case, so a catalog rename fails here rather than leaving the
// attempt vocabulary pinned against a fixture nothing executes.
function attemptContext(): AttemptContext {
  const definition = evaluationCase(CASE_ID);
  if (definition === undefined) {
    throw new Error(`${CASE_ID} is not a bundled evaluation case`);
  }
  return {
    definition,
    startedAt: DateTime.unsafeMake(0),
    cell: {
      attemptId: decodeEvaluationAttemptId("eval-019-nanoclaw-1"),
      casePlan: EvaluationCasePlan.make({
        id: CASE_ID,
        definitionId: definition.definitionId,
        name: CASE_ID,
        description: `Deterministic ${CASE_ID} fixture.`,
        rubric: `Assess ${CASE_ID}.`,
        criterionIds: [decodeCriterionId(`${CASE_ID}.result/v1`)],
        slices: ["baseline"],
      }),
      conditionPlan: EvaluationConditionPlan.make({
        id: decodeConditionId("nanoclaw/v2"),
        runtimeName: "nanoclaw",
        runtimeConfiguration: { mode: "deterministic" },
      }),
      sample: 1,
    },
  };
}

const RECEIPT = IncompleteLedgerReceipt.make({
  ledger: Schema.decodeSync(ledgerRef)("eval-019-nanoclaw-1"),
});

effect.each(["MOLTZAP_CONTROLLER_IMAGE", "MOLTZAP_NANOCLAW_IMAGE"] as const)(
  "names %s in both configuration failures",
  (key: EvaluationImageKey) =>
    Effect.sync(() => {
      assert.include(missingImageDetail(key), key);
      assert.include(invalidImageDetail(key), key);
    }),
);

const CLUSTER_LOST = { _tag: "ClusterLost", receipt: RECEIPT } as const;
const ALLOCATION_FAILED = { _tag: "LedgerAllocationFailed" } as const;

// The operator-facing account either infrastructure attempt carries.
function attemptAccount(
  attempt: Effect.Effect.Success<ReturnType<typeof infrastructureFailed>>,
): string {
  return attempt._tag === "RunFailedAttempt"
    ? attempt.detail
    : attempt.failure.detail;
}

// Both infrastructure attempts already carry the operator-facing account of a
// failure, and phoenix-run publishes exactly that field as the run's error, so
// the controller's own account belongs in it rather than beside it.
effect.each([
  ["a lost cluster", CLUSTER_LOST, "infrastructure failure"],
  ["a failed allocation", ALLOCATION_FAILED, "durable ledger"],
] as const)("gives %s the controller account", ([, summary, canned]) =>
  Effect.gen(function* () {
    const context = attemptContext();

    assert.strictEqual(
      attemptAccount(yield* infrastructureFailed(context, summary, DIAGNOSTIC)),
      DIAGNOSTIC,
    );
    assert.include(
      attemptAccount(yield* infrastructureFailed(context, summary)),
      canned,
    );
  }),
);

// Without a controller account the two attempts still have to be told apart:
// a run that never got a ledger and a run that lost its cluster are different
// operator problems, and the fallback text is all that says which happened.
it("distinguishes the two infrastructure failures when neither left an account", () =>
  Effect.gen(function* () {
    const context = attemptContext();
    const failedRun = yield* infrastructureFailed(context, CLUSTER_LOST);
    const failedAllocation = yield* infrastructureFailed(
      context,
      ALLOCATION_FAILED,
    );

    assert.notStrictEqual(
      attemptAccount(failedRun),
      attemptAccount(failedAllocation),
    );
  }));
