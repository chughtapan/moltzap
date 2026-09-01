/** @file Evaluation command selection preserves an exact executable subset. */

import { assert, it } from "@effect/vitest";
import { Option } from "effect";
import { evaluationCases } from "./cases.js";
import { decodeEvaluationCaseId } from "./model.js";
import { resolveEvaluationRunSelection } from "./selection.js";

const OPENCLAW_SELECTION = {
  runtime: "openclaw",
  openclawModel: Option.some("openai/test"),
  nanoclawModel: Option.none<string>(),
  messagingMode: "shared",
  profile: "local",
} as const;

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
