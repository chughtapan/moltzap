/** @file The restored case catalog stays complete and Client-semantic. */

import { assert, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  evaluationCase,
  type EvaluationCaseProgramContext,
  evaluationCases,
  PEER_AGENT_NAME,
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
        return Option.some(PRINCIPAL_EVIDENCE);
      }),
    selectPrincipalOutput: (output) =>
      Effect.sync(() => {
        operations.push("select:principal");
        return Option.getOrThrow(output);
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

// @agent-code-guard/regression-only: these examples pin the finite bundled catalog, its exact orchestration traces, and deterministic timeout handling.
it("owns the exact ordered sixteen-case catalog", () => {
  assert.deepStrictEqual(
    evaluationCases.map(({ id }) => id),
    [
      "EVAL-005",
      "EVAL-006",
      "EVAL-007",
      "EVAL-008",
      "EVAL-009",
      "EVAL-010",
      "EVAL-011",
      "EVAL-018",
      "EVAL-019",
      "EVAL-021",
      "EVAL-022",
      "EVAL-030",
      "EVAL-031",
      "EVAL-032",
      "EVAL-033",
      "EVAL-034",
    ],
  );
  assert.isTrue(Object.isFrozen(evaluationCases));
  for (const definition of evaluationCases) {
    assert.isTrue(Object.isFrozen(definition));
    assert.isTrue(Object.isFrozen(definition.peers));
  }
});

it.effect("selects one peer-observed target action for a direct case", () =>
  Effect.gen(function* () {
    const definition = evaluationCase(decodeEvaluationCaseId("EVAL-005"));
    assert.isDefined(definition);
    if (definition === undefined) {
      return;
    }
    const operations: string[] = [];
    const selected = yield* definition.program(context(operations));

    assert.strictEqual(selected, SOCIAL_EVIDENCE);
    assert.match(operations[0] ?? "", new RegExp(PEER_AGENT_NAME, "u"));
    assert.strictEqual(operations[1], `select:${PEER_AGENT_NAME}`);
    assert.deepStrictEqual(Object.keys(definition.peers), [PEER_AGENT_NAME]);
  }),
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
