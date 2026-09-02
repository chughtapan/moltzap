/** @file Evaluation command selection preserves an exact executable subset. */

import { assert, it } from "@effect/vitest";
import { Either, Option, Schema } from "effect";
import { evaluationCases } from "./cases.js";
import { decodeEvaluationCaseId } from "./model.js";
import {
  DEFAULT_EVALUATION_CONCURRENCY,
  evaluationConcurrency,
  MAX_EVALUATION_CONCURRENCY,
  resolveEvaluationRunSelection,
} from "./selection.js";

const OPENCLAW_SELECTION = {
  runtime: "openclaw",
  openclawModel: Option.some("openai/test"),
  nanoclawModel: Option.none<string>(),
  messagingMode: "shared",
  profile: "local",
  concurrency: DEFAULT_EVALUATION_CONCURRENCY,
} as const;

// @agent-code-guard/regression-only: command-line selection pins exact ordered case subsets and the closed concurrency range.
it("selects repeated case options in command order", () => {
  const selection = resolveEvaluationRunSelection({
    ...OPENCLAW_SELECTION,
    caseIds: [
      decodeEvaluationCaseId("EVAL-006"),
      decodeEvaluationCaseId("EVAL-010"),
      decodeEvaluationCaseId("EVAL-011"),
    ],
  });

  assert.deepStrictEqual(
    selection.cases.map(({ id }) => id),
    ["EVAL-006", "EVAL-010", "EVAL-011"],
  );
});

it("uses the full catalog only when no case option is present", () => {
  const selection = resolveEvaluationRunSelection({
    ...OPENCLAW_SELECTION,
    caseIds: [],
  });

  assert.strictEqual(selection.cases, evaluationCases);
});

it("rejects unknown and duplicate case options", () => {
  assert.throws(
    () =>
      resolveEvaluationRunSelection({
        ...OPENCLAW_SELECTION,
        caseIds: [decodeEvaluationCaseId("EVAL-999")],
      }),
    /not in the bundled evaluation catalog/u,
  );
  assert.throws(
    () =>
      resolveEvaluationRunSelection({
        ...OPENCLAW_SELECTION,
        caseIds: [
          decodeEvaluationCaseId("EVAL-006"),
          decodeEvaluationCaseId("EVAL-006"),
        ],
      }),
    /selected more than once/u,
  );
});

it("accepts a concurrency from one to the ceiling and refuses the rest", () => {
  const decode = Schema.decodeUnknownEither(evaluationConcurrency);
  const accepted = (value: number) =>
    Either.match(decode(value), { onLeft: () => false, onRight: () => true });

  assert.isTrue(accepted(1));
  assert.isTrue(accepted(DEFAULT_EVALUATION_CONCURRENCY));
  assert.isTrue(accepted(MAX_EVALUATION_CONCURRENCY));
  assert.isFalse(accepted(0));
  assert.isFalse(accepted(MAX_EVALUATION_CONCURRENCY + 1));
  assert.isFalse(accepted(2.5));
});

it("carries the concurrency beside the selection rather than in the plan options", () => {
  const selection = resolveEvaluationRunSelection({
    ...OPENCLAW_SELECTION,
    caseIds: [],
    concurrency: 2,
  });

  assert.strictEqual(selection.concurrency, 2);
  assert.notProperty(selection.options, "concurrency");
});
