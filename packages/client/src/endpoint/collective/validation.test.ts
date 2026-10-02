/** @file Pins answer validation and member outcomes against a form-mode schema. */

import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { AnswerContent } from "../../contract.js";
import { outcomeOfResponse, validateAnswer } from "./validation.js";
import { decodeCollectiveResponse, FormModeSchema } from "./wire.js";

const requestedSchema = Schema.decodeUnknownSync(FormModeSchema)({
  type: "object",
  properties: {
    slot: { type: "string", enum: ["mon", "tue"] },
    hours: { type: "number", minimum: 0 },
  },
  required: ["slot"],
});
const collectiveId = `col_${"A".repeat(43)}`;

const response = (value: unknown) =>
  Effect.runSync(decodeCollectiveResponse(value));

const failingFields = (content: AnswerContent) =>
  Effect.runSync(
    Effect.flip(validateAnswer(requestedSchema, content)),
  ).failures.map(({ field, reason }) => ({ field, reason }));

// @agent-code-guard/regression-only: examples pin which answer fields fail and how each failure is named.
describe("answer validation", () => {
  it("accepts an answer satisfying every field", () => {
    const content = { slot: "tue", hours: 2 };

    expect(Effect.runSync(validateAnswer(requestedSchema, content))).toBe(
      content,
    );
  });

  it("names a field whose value fails its property schema", () => {
    expect(failingFields({ slot: "wed" })).toEqual([
      { field: "slot", reason: "invalid" },
    ]);
  });

  it("names a missing required field", () => {
    expect(failingFields({ hours: 1 })).toEqual([
      { field: "slot", reason: "missing" },
    ]);
  });

  it("names a field the schema does not declare", () => {
    expect(failingFields({ slot: "mon", mood: "fine" })).toEqual([
      { field: "mood", reason: "unexpected" },
    ]);
  });

  it("names an undeclared field that shares an Object.prototype name", () => {
    expect(failingFields({ slot: "mon", constructor: "x" })).toEqual([
      { field: "constructor", reason: "unexpected" },
    ]);
  });

  it("names a missing required field that shares an Object.prototype name", () => {
    const toStringSchema = Schema.decodeUnknownSync(FormModeSchema)({
      type: "object",
      properties: { toString: { type: "string" } },
      required: ["toString"],
    });

    expect(
      Effect.runSync(
        Effect.flip(validateAnswer(toStringSchema, {})),
      ).failures.map(({ field, reason }) => ({ field, reason })),
    ).toEqual([{ field: "toString", reason: "missing" }]);
  });

  it("names every failing field of one answer", () => {
    expect(failingFields({ slot: "wed", hours: -1 })).toEqual([
      { field: "slot", reason: "invalid" },
      { field: "hours", reason: "invalid" },
    ]);
  });
});

// @agent-code-guard/regression-only: examples pin the one outcome each response action records.
describe("member outcomes", () => {
  it("records a valid accept as answered with its content", () => {
    const accepted = response({
      kind: "response",
      id: collectiveId,
      action: "accept",
      content: { slot: "mon" },
    });

    expect(
      Effect.runSync(outcomeOfResponse(requestedSchema, accepted)),
    ).toEqual({ kind: "answered", content: { slot: "mon" } });
  });

  it("records an accept failing the schema as invalid", () => {
    const accepted = response({
      kind: "response",
      id: collectiveId,
      action: "accept",
      content: { slot: "wed" },
    });

    expect(
      Effect.runSync(outcomeOfResponse(requestedSchema, accepted)),
    ).toMatchObject({ kind: "invalid" });
  });

  it("records a decline as declined", () => {
    const declined = response({
      kind: "response",
      id: collectiveId,
      action: "decline",
    });

    expect(
      Effect.runSync(outcomeOfResponse(requestedSchema, declined)),
    ).toEqual({ kind: "declined" });
  });

  it("refuses a cancel, which is no longer an answer", () => {
    const decoded = Effect.runSyncExit(
      decodeCollectiveResponse({
        kind: "response",
        id: collectiveId,
        action: "cancel",
      }),
    );

    expect(Exit.isFailure(decoded)).toBe(true);
  });
});
