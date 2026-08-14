/** @file Pins caller-side conversation identity creation before START. */

import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ConversationId, createConversationId } from "./contract.js";

const mintTwoConversationIds = Effect.gen(function* () {
  const first = yield* createConversationId();
  const second = yield* createConversationId();
  return { first, second };
});

// @agent-code-guard/regression-only: ConversationId is caller-retained retry identity and must be valid before START.
describe("createConversationId", () => {
  it("mints distinct values accepted by the public ConversationId schema", () => {
    const { first, second } = Effect.runSync(mintTwoConversationIds);

    expect(Schema.decodeUnknownSync(ConversationId)(first)).toBe(first);
    expect(Schema.decodeUnknownSync(ConversationId)(second)).toBe(second);
    expect(first).not.toBe(second);
  });
});
