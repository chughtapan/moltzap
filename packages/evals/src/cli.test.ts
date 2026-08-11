import { assert, effect, it } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import { DateTime, Effect, Schema } from "effect";
import { IncompleteLedgerReceipt } from "@moltzap/simulator";
import { ledgerRef } from "@moltzap/simulator/ledger";
import { evaluationCase } from "./cases.js";
import {
  infrastructureFailed,
  invalidImageDetail,
  missingImageDetail,
  type AttemptContext,
  type EvaluationImageKey,
} from "./cli.js";
import {
  decodeEvaluationCaseId,
  decodeCriterionId,
  decodeConditionId,
} from "./model.js";
import {
  EvaluationCasePlan,
  EvaluationConditionPlan,
  decodeEvaluationAttemptId,
} from "./sweep.js";

const CASE_ID = decodeEvaluationCaseId("EVAL-006");
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
      attemptId: decodeEvaluationAttemptId("eval-006-nanoclaw-1"),
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
  ledger: Schema.decodeSync(ledgerRef)("eval-006-nanoclaw-1"),
});

// An operator whose environment is missing an image has no other way to learn
// that the reference is produced rather than looked up, and the NanoClaw image
// has no producer anywhere else in the repository.
effect.each([
  ["MOLTZAP_CONTROLLER_IMAGE", "build-controller-image.mjs"],
  ["MOLTZAP_SUPPORT_IMAGE", "build-controller-image.mjs"],
  ["MOLTZAP_NANOCLAW_IMAGE", "build-nanoclaw-image.mjs"],
] as const)(
  "names the producer of %s in both of its configuration failures",
  ([key, script]: readonly [EvaluationImageKey, string]) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const producer = `packages/simulator/scripts/${script}`;

      for (const detail of [missingImageDetail(key), invalidImageDetail(key)]) {
        assert.include(detail, key);
        assert.include(detail, producer);
        assert.include(detail, "pinnedImage");
      }

      // A named script that does not exist is worse than no remedy at all.
      assert.isTrue(
        yield* fileSystem.exists(
          fileURLToPath(new URL(`../../../${producer}`, import.meta.url)),
        ),
        `${producer} does not exist`,
      );
    }).pipe(Effect.provide(NodeContext.layer)),
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
