/** @file Refusal references survive the public printable error boundary. */

import { Encoding } from "effect";
import { expect, it } from "vitest";
import { FirewallSendError } from "../index.js";

const checkId = `chk_${Encoding.encodeHex(new Uint8Array(32).fill(2))}`;
const feedback = {
  nextAction: "revise",
  text: "Include Carol in the scheduling reply.",
} as const;

it.each([{ feedback: [] }, { feedback: [feedback] }])(
  "retains a check reference in refusal text with feedback $feedback",
  (example) => {
    const refusal = new FirewallSendError({
      checkId,
      refusal: "norm-violation",
      feedback: example.feedback,
    });
    expect(refusal.message).toContain(checkId);
    for (const item of example.feedback) {
      expect(refusal.message).toContain(item.text);
    }
    expect(String(refusal)).toContain(checkId);
  },
);

const advice = "The communication prerequisite is not satisfied.";

it.each([
  { nextAction: "revise", refusal: "norm-violation" },
  { nextAction: "wait", refusal: "norm-violation" },
  { nextAction: "stop", refusal: "norm-violation" },
  { nextAction: "seek-approval", refusal: "approval-required" },
] as const)(
  "preserves the $nextAction next action in printable refusals",
  ({ nextAction, refusal }) => {
    const error = new FirewallSendError({
      checkId,
      refusal,
      feedback: [{ nextAction, text: advice }],
    });
    expect(error.message).toContain(nextAction);
    expect(error.message).toContain(advice);
    expect(String(error)).toContain(nextAction);
  },
);

it.each(["wait", "stop"] as const)(
  "does not direct revision when a norm requires the next action %s",
  (nextAction) => {
    const refusal = new FirewallSendError({
      checkId,
      refusal: "norm-violation",
      feedback: [{ nextAction, text: advice }],
    });
    expect(refusal.message).not.toMatch(/revis(?:e|ion)/u);
  },
);
