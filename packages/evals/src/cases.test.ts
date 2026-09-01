/** @file Bundled evaluation case execution and timeout decisions. */

import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  evaluationCase,
  type EvaluationCaseProgramContext,
  evaluationCases,
  PROBE_AGENT_NAME,
  SOURCE_AGENT_NAME,
} from "./cases.js";
import {
  CriterionDecided,
  criterionVerdict,
  decodeEvaluationCaseId,
  decodeEvaluationEvidenceId,
} from "./model.js";

const SOCIAL_EVIDENCE = decodeEvaluationEvidenceId("case:social");
const PRINCIPAL_EVIDENCE = decodeEvaluationEvidenceId("case:principal");
const FAILED_VERDICT = Schema.decodeSync(criterionVerdict)("failed");

function context(operations: string[]): EvaluationCaseProgramContext<never> {
  return {
    instruct: (message) =>
      Effect.sync(() => {
        operations.push(`instruct:${message}`);
      }),
    ask: (message) =>
      Effect.sync(() => {
        operations.push(`ask:${message}`);
        return PRINCIPAL_EVIDENCE;
      }),
    observePeer: (agent) =>
      Effect.sync(() => {
        operations.push(`observe:${agent}`);
      }),
    selectSocialOutput: (agent) =>
      Effect.sync(() => {
        operations.push(`select:${agent}`);
        return SOCIAL_EVIDENCE;
      }),
  };
}

it.effect("executes every bundled case with grading criteria", () =>
  Effect.forEach(
    evaluationCases,
    (definition) =>
      Effect.gen(function* () {
        const operations: string[] = [];
        const selected = yield* definition.program(context(operations));

        assert.isAbove(definition.criteria.length, 0);
        assert.isAbove(definition.slices.length, 0);
        assert.isAbove(operations.length, 0);
        assert.oneOf(selected, [PRINCIPAL_EVIDENCE, SOCIAL_EVIDENCE]);
      }),
    { concurrency: 1, discard: true },
  ),
);

it.effect("keeps source and probe interactions in separate case steps", () =>
  Effect.gen(function* () {
    const definition = evaluationCase(decodeEvaluationCaseId("EVAL-008"));
    assert.isDefined(definition);
    if (definition === undefined) {
      return;
    }
    const operations: string[] = [];
    const selected = yield* definition.program(context(operations));

    assert.strictEqual(selected, SOCIAL_EVIDENCE);
    assert.strictEqual(operations[1], `observe:${SOURCE_AGENT_NAME}`);
    assert.strictEqual(operations[3], `select:${PROBE_AGENT_NAME}`);
    assert.deepStrictEqual(Object.keys(definition.peers), [
      SOURCE_AGENT_NAME,
      PROBE_AGENT_NAME,
    ]);
  }),
);

it("turns any selected prerequisite timeout into a deterministic failure", () => {
  const definition = evaluationCase(decodeEvaluationCaseId("EVAL-005"));
  assert.isDefined(definition);
  if (definition === undefined) {
    return;
  }
  const decision = definition.criteria[0].decide({
    selected: [
      {
        evidenceId: SOCIAL_EVIDENCE,
        source: "peer-timeout",
        parts: [{ type: "text", text: "No social action arrived." }],
      },
      {
        evidenceId: PRINCIPAL_EVIDENCE,
        source: "social",
        parts: [{ type: "text", text: "A later exchange completed." }],
      },
    ],
  });
  assert.instanceOf(decision, CriterionDecided);
  if (decision instanceof CriterionDecided) {
    assert.strictEqual(decision.verdict, FAILED_VERDICT);
    assert.deepStrictEqual(decision.citations, [SOCIAL_EVIDENCE]);
  }
});
