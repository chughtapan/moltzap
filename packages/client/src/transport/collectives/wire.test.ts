/** @file Pins the collective values carried in a post's data part. */

import { Effect, Encoding, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AgentAddress } from "../messaging/address.js";
import { Content } from "../wire/index.js";
import {
  COLLECTIVE_DATA_KEY,
  CollectiveContentError,
  collectiveIdOf,
  CollectivePartInvalidError,
  decodeCollectiveValue,
  encodeCollectiveContent,
  FormModeSchema,
  readCollectiveValue,
} from "./wire.js";

const collectiveId = `col_${"A".repeat(43)}`;
const nonce = "B".repeat(43);
const recordHash = `rch_${Encoding.encodeBase64Url(new Uint8Array(32).fill(2))}`;
const deadlineAt = 1_790_000_000_000;
const flatSchema = {
  type: "object",
  properties: {
    slot: { type: "string", enum: ["mon", "tue"] },
    note: { type: "string" },
    hours: { type: "number", minimum: 0 },
    confirmed: { type: "boolean" },
  },
  required: ["slot"],
};
const gather = {
  kind: "operation",
  op: "gather",
  id: collectiveId,
  nonce,
  deadlineAt,
  requestedSchema: flatSchema,
};

const decodes = (value: unknown): boolean =>
  Exit.isSuccess(Effect.runSyncExit(decodeCollectiveValue(value)));

const decodesSchema = (value: unknown): boolean =>
  Exit.isSuccess(
    Effect.runSyncExit(Schema.decodeUnknown(FormModeSchema)(value)),
  );

const decodeValue = (value: unknown) =>
  Effect.runSync(decodeCollectiveValue(value));

// @agent-code-guard/regression-only: examples pin the closed collective content round trip.
describe("collective content round trip", () => {
  it("round-trips a gather request through post content", () => {
    const content = Effect.runSync(
      encodeCollectiveContent(decodeValue(gather), "Which day?"),
    );

    expect(Effect.runSync(readCollectiveValue(content))).toEqual(
      Option.some(decodeValue(gather)),
    );
  });

  it("puts the question text before the collective data part", () => {
    const content = Effect.runSync(
      encodeCollectiveContent(decodeValue(gather), "Which day?"),
    );

    expect(content).toEqual([
      { type: "text", text: "Which day?" },
      { type: "data", value: { [COLLECTIVE_DATA_KEY]: gather } },
    ]);
  });

  it("round-trips an all_gather close record", () => {
    const close = { kind: "close", id: collectiveId, included: [recordHash] };

    const content = Effect.runSync(encodeCollectiveContent(decodeValue(close)));

    expect(Effect.runSync(readCollectiveValue(content))).toEqual(
      Option.some(decodeValue(close)),
    );
  });
});

// @agent-code-guard/regression-only: examples pin the closed operation and response wire grammar.
describe("collective value grammar", () => {
  it("accepts a multicast operation with only its discriminants", () => {
    expect(decodes({ kind: "operation", op: "multicast" })).toBe(true);
  });

  it("rejects a multicast operation carrying a deadline", () => {
    expect(decodes({ kind: "operation", op: "multicast", deadlineAt })).toBe(
      false,
    );
  });

  it("rejects a multicast operation carrying a requested schema", () => {
    expect(
      decodes({
        kind: "operation",
        op: "multicast",
        requestedSchema: flatSchema,
      }),
    ).toBe(false);
  });

  it("rejects a gather without a deadline", () => {
    expect(
      decodes({
        kind: "operation",
        op: "gather",
        id: collectiveId,
        nonce,
        requestedSchema: flatSchema,
      }),
    ).toBe(false);
  });

  it("rejects an all_gather without a requested schema", () => {
    expect(
      decodes({
        kind: "operation",
        op: "all_gather",
        id: collectiveId,
        nonce,
        deadlineAt,
      }),
    ).toBe(false);
  });
});

// @agent-code-guard/regression-only: examples pin that only an accept response carries content.
describe("collective response grammar", () => {
  it("accepts an accept response carrying content", () => {
    expect(
      decodes({
        kind: "response",
        id: collectiveId,
        action: "accept",
        content: { slot: "mon" },
      }),
    ).toBe(true);
  });

  it("rejects a decline response carrying content", () => {
    expect(
      decodes({
        kind: "response",
        id: collectiveId,
        action: "decline",
        content: { slot: "mon" },
      }),
    ).toBe(false);
  });

  it("rejects an accept response without content", () => {
    expect(
      decodes({ kind: "response", id: collectiveId, action: "accept" }),
    ).toBe(false);
  });
});

// @agent-code-guard/regression-only: examples pin the MCP form-mode grammar the SDK accepts.
describe("requested schema grammar", () => {
  it("accepts a flat schema of enum, string, number and boolean fields", () => {
    expect(decodesSchema(flatSchema)).toBe(true);
  });

  it("rejects a nested object property", () => {
    expect(
      decodesSchema({
        type: "object",
        properties: { where: { type: "object", properties: {} } },
      }),
    ).toBe(false);
  });

  it("rejects a required name that is not a property", () => {
    expect(
      decodesSchema({
        type: "object",
        properties: { note: { type: "string" } },
        required: ["slot"],
      }),
    ).toBe(false);
  });

  it("accepts a multi-select only when its items carry a string type", () => {
    const multiSelect = (items: object) => ({
      type: "object",
      properties: { slots: { type: "array", items } },
    });

    expect(decodesSchema(multiSelect({ type: "string", enum: ["a"] }))).toBe(
      true,
    );
    expect(decodesSchema(multiSelect({ enum: ["a"] }))).toBe(false);
  });

  it("rejects a property the answer validator cannot compile", () => {
    expect(
      decodesSchema({
        type: "object",
        properties: { slot: { type: "string", enum: [] } },
      }),
    ).toBe(false);
  });
});

// @agent-code-guard/regression-only: examples pin how content carries at most one collective part within the size limit.
describe("collective content", () => {
  it("reads content without a collective part as none", () => {
    const content = Schema.decodeUnknownSync(Content)([
      { type: "text", text: "hello" },
      { type: "data", value: { other: 1 } },
    ]);

    expect(Effect.runSync(readCollectiveValue(content))).toEqual(Option.none());
  });

  it("rejects content carrying two collective parts", () => {
    const part = { type: "data", value: { [COLLECTIVE_DATA_KEY]: gather } };
    const content = Schema.decodeUnknownSync(Content)([part, part]);

    expect(
      Effect.runSync(Effect.flip(readCollectiveValue(content))),
    ).toStrictEqual(new CollectivePartInvalidError({ reason: "duplicate" }));
  });

  it("rejects a collective part that does not decode", () => {
    const content = Schema.decodeUnknownSync(Content)([
      { type: "data", value: { [COLLECTIVE_DATA_KEY]: { kind: "unknown" } } },
    ]);

    expect(
      Effect.runSync(Effect.flip(readCollectiveValue(content))),
    ).toStrictEqual(new CollectivePartInvalidError({ reason: "malformed" }));
  });

  it("rejects a request whose question exceeds the content limit", () => {
    const failure = Effect.runSync(
      Effect.flip(
        encodeCollectiveContent(decodeValue(gather), "q".repeat(32_768)),
      ),
    );

    expect(failure).toStrictEqual(new CollectiveContentError());
  });
});

// @agent-code-guard/regression-only: examples pin that a collective id names its requester.
describe("collective id derivation", () => {
  const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
  const mallory = Schema.decodeUnknownSync(AgentAddress)("agent:mallory");

  it("derives the same id from the same requester and nonce", () => {
    expect(collectiveIdOf(bob, nonce)).toBe(collectiveIdOf(bob, nonce));
  });

  it("rejects a gather request without the nonce its id derives from", () => {
    expect(
      decodes({
        kind: "operation",
        op: "gather",
        id: collectiveId,
        deadlineAt,
        requestedSchema: flatSchema,
      }),
    ).toBe(false);
  });

  it("derives a different id for another requester with the same nonce", () => {
    expect(collectiveIdOf(mallory, nonce)).not.toBe(collectiveIdOf(bob, nonce));
  });
});
