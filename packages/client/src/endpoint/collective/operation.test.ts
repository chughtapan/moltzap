/** @file Pins how an operation becomes post content and a post becomes an item. */

import { Effect, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InboundMessage, SendInput } from "../../contract.js";
import { inboundItem, operationContent } from "./operation.js";

const multicastPart = {
  type: "data",
  value: { "xyz.moltzap/collective": { kind: "operation", op: "multicast" } },
};
const postId = `pst_${"A".repeat(43)}`;
const declinePart = {
  type: "data",
  value: {
    "xyz.moltzap/collective": {
      kind: "response",
      id: `col_${"A".repeat(43)}`,
      action: "decline",
    },
  },
};
const malformedPart = {
  type: "data",
  value: { "xyz.moltzap/collective": { kind: "operation" } },
};

const operation = (input: unknown) =>
  Effect.runSync(operationContent(Schema.decodeUnknownSync(SendInput)(input)));

const directPost = (content: unknown) =>
  Schema.decodeUnknownSync(InboundMessage)({
    kind: "direct",
    postId,
    address: "agent:bob",
    sender: "agent:bob",
    content,
  });

const classify = (content: unknown) =>
  Effect.runSync(inboundItem(directPost(content)));

// @agent-code-guard/regression-only: examples pin the explicit multicast part every authored post carries.
describe("operation content", () => {
  it("carries a send without a collective operation as an explicit multicast", () => {
    expect(operation({ to: "agent:bob", text: "Hello" })).toEqual([
      { type: "text", text: "Hello" },
      multicastPart,
    ]);
  });

  it("carries a collective operation that omits op as a multicast", () => {
    expect(
      operation({ to: "agent:bob", text: "Hello", collective: {} }),
    ).toEqual([{ type: "text", text: "Hello" }, multicastPart]);
  });

  it("fails when the text and its operation part exceed the content limit", () => {
    const input = Schema.decodeUnknownSync(SendInput)({
      to: "agent:bob",
      text: "a".repeat(32_741),
    });

    expect(Exit.isFailure(Effect.runSyncExit(operationContent(input)))).toBe(
      true,
    );
  });
});

// @agent-code-guard/regression-only: examples pin which certified posts reach the subscriber and in what form.
describe("inbound item classification", () => {
  it("delivers a multicast without its collective part", () => {
    expect(classify([{ type: "text", text: "Hello" }, multicastPart])).toEqual(
      Option.some({
        kind: "multicast",
        message: directPost([{ type: "text", text: "Hello" }]),
      }),
    );
  });

  it("delivers a post without a collective part as a multicast", () => {
    const content = [{ type: "text", text: "Hello" }];

    expect(classify(content)).toEqual(
      Option.some({ kind: "multicast", message: directPost(content) }),
    );
  });

  it("consumes a multicast whose only part is the collective part", () => {
    expect(classify([multicastPart])).toEqual(Option.none());
  });

  it("consumes a post whose collective part is malformed", () => {
    expect(classify([{ type: "text", text: "Hello" }, malformedPart])).toEqual(
      Option.none(),
    );
  });

  it("consumes a post that carries two collective parts", () => {
    expect(
      classify([{ type: "text", text: "Hello" }, multicastPart, multicastPart]),
    ).toEqual(Option.none());
  });

  it("consumes a collective response", () => {
    expect(classify([{ type: "text", text: "No" }, declinePart])).toEqual(
      Option.none(),
    );
  });
});
