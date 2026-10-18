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
