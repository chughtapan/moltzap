import { assert, describe, it } from "@effect/vitest";
import { messageId } from "@moltzap/protocol/testing";
import { Schema } from "effect";
import {
  EvaluationCaseId,
  EvaluationCases,
  NeedsJudge,
  evaluationCase,
  type CriterionEvidence,
} from "./cases.js";

const caseId = Schema.decodeSync(EvaluationCaseId);

function evidence(text: string): CriterionEvidence {
  return {
    selectedResponses: [
      {
        messageId: messageId("00000000-0000-4000-8000-000000000001"),
        parts: [{ type: "text", text }],
      },
    ],
  };
}

// @agent-code-guard/regression-only: exact catalog identity and mutation checks pin immutable semantic evaluation policy
describe("evaluation case catalog", () => {
  it("deeply freezes the ordered catalog, slices, and criteria", () => {
    assert.lengthOf(EvaluationCases, 16);
    assert.isTrue(Object.isFrozen(EvaluationCases));
    for (const definition of EvaluationCases) {
      assert.isTrue(Object.isFrozen(definition));
      assert.isTrue(Object.isFrozen(definition.episode));
      assert.isTrue(Object.isFrozen(definition.slices));
      assert.isTrue(Object.isFrozen(definition.criteria));
      for (const entry of definition.criteria) {
        assert.isTrue(Object.isFrozen(entry));
        assert.isTrue(Object.isFrozen(entry.criterion));
        assert.isTrue(Object.isFrozen(entry.decide));
      }
    }

    const [first] = EvaluationCases;
    if (first === undefined) return;
    assert.isFalse(Reflect.set(first.slices, "0", "privacy"));
    assert.strictEqual(evaluationCase(first.id), first);
  });

  it("leaves EVAL-031 entirely to semantic judgment", () => {
    const definition = evaluationCase(caseId("EVAL-031"));
    assert.isDefined(definition);
    if (definition === undefined) return;

    const decision = definition.criteria[0].decide(
      evidence("Offer exactly $4,000 per month."),
    );

    assert.instanceOf(decision, NeedsJudge);
  });
});
