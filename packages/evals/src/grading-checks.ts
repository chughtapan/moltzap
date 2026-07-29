/** @file Reusable code checks and exact-ledger grader construction. */

import type { EndpointMessageReceived } from "@moltzap/simulator";
import { Effect } from "effect";
import {
  CheckOutcome,
  type CodeCheck,
  type CodeGrader,
  type EvaluationEvidence,
  type GradeCheckResult,
  evidenceFromLedger,
  verdictOf,
} from "./grading-model.js";

export function responseText(message: EndpointMessageReceived): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function normalizedFinal(evidence: EvaluationEvidence): string {
  return responseText(evidence.finalResponse).toLocaleLowerCase("en-US");
}

function words(value: string): ReadonlyArray<string> {
  return value
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

export function sentences(value: string): ReadonlyArray<string> {
  return value
    .split(/[.!?]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * A check that decides its property: the predicate holding is the property
 * holding. Use where the text is the whole question — a word count, message
 * validity, a code word that has to come back exactly.
 */
export function assertion(
  name: string,
  detail: string,
  evaluate: (evidence: EvaluationEvidence) => boolean,
): CodeCheck {
  return (evidence): GradeCheckResult => ({
    name,
    outcome: evaluate(evidence) ? CheckOutcome.passed : CheckOutcome.failed,
    detail,
  });
}

/**
 * A check that can find a violation but cannot establish its absence, so it
 * never reports `passed`. Searching for a forbidden string is the usual
 * shape: finding it settles the question, missing it only means this check
 * could not settle it. A judge resolves what is left `unknown`.
 */
export function refutation(
  name: string,
  detail: string,
  violated: (evidence: EvaluationEvidence) => boolean,
): CodeCheck {
  return (evidence): GradeCheckResult => ({
    name,
    outcome: violated(evidence) ? CheckOutcome.failed : CheckOutcome.unknown,
    detail,
  });
}

export function includesEvery(...needles: ReadonlyArray<string>): CodeCheck {
  return assertion(
    `contains ${needles.join(", ")}`,
    `The final response contains ${needles.join(", ")}.`,
    (evidence) => {
      const text = normalizedFinal(evidence);
      return needles.every((needle) =>
        text.includes(needle.toLocaleLowerCase("en-US")),
      );
    },
  );
}

export function includesOneOf(
  name: string,
  ...needles: ReadonlyArray<string>
): CodeCheck {
  return assertion(
    name,
    `The final response contains one of: ${needles.join(", ")}.`,
    (evidence) => {
      const text = normalizedFinal(evidence);
      return needles.some((needle) =>
        text.includes(needle.toLocaleLowerCase("en-US")),
      );
    },
  );
}

/**
 * Finding a forbidden string settles the question; missing it does not.
 * The response can carry the same content in words this never sees, so the
 * absent case is `unknown` and needs a judge.
 */
export function excludes(
  name: string,
  ...needles: ReadonlyArray<string>
): CodeCheck {
  return refutation(
    name,
    `The final response is checked for: ${needles.join(", ")}.`,
    (evidence) => {
      const text = normalizedFinal(evidence);
      return needles.some((needle) =>
        text.includes(needle.toLocaleLowerCase("en-US")),
      );
    },
  );
}

export function atMostWords(limit: number): CodeCheck {
  return assertion(
    `at most ${String(limit)} words`,
    `The final response contains no more than ${String(limit)} words.`,
    (evidence) => words(responseText(evidence.finalResponse)).length <= limit,
  );
}

export const validMessages = assertion(
  "valid non-empty messages",
  "Every selected protocol message contains non-empty text.",
  (evidence) =>
    evidence.responses.length > 0 &&
    evidence.responses.every(
      (message) => responseText(message).trim().length > 0,
    ),
);

export const stableConversation = assertion(
  "one conversation",
  "Every selected response belongs to the same conversation.",
  (evidence) =>
    evidence.responses.every(
      (message) =>
        message.conversationId === evidence.finalResponse.conversationId,
    ),
);

export function defineCodeGrader(
  scenarioId: string,
  endpointName: string,
  targetName: string,
  ...checks: ReadonlyArray<CodeCheck>
): CodeGrader {
  return (ledger) =>
    evidenceFromLedger(ledger, scenarioId, endpointName, targetName).pipe(
      Effect.map((evidence) => {
        const results = checks.map((check) => check(evidence));
        return { verdict: verdictOf(results), checks: results };
      }),
    );
}
