/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function -- Codec scenarios keep each binding and malformed-token matrix beside its roundtrip setup. */
import { describe, expect, it } from "vitest";
import { Effect, Either, Schema } from "effect";
import { conversationId } from "@moltzap/protocol/conversation";
import { agentId } from "@moltzap/protocol/identity";
import { InvalidParamsError } from "@moltzap/protocol/rpc";
import {
  READ_PLANE_PAGE_SIZE,
  decodeConversationCheckpoint,
  decodeConversationReadCursor,
  decodeSearchCursor,
  encodeConversationCheckpoint,
  encodeConversationReadCursor,
  encodeSearchCursor,
  normalizeSearchQuery,
  paginateSearchRows,
} from "./search-read-cursor.js";

const CALLER_ID = Schema.decodeSync(agentId)(
  "00000000-0000-4000-8000-000000000001",
);
const OTHER_AGENT_ID = Schema.decodeSync(agentId)(
  "00000000-0000-4000-8000-000000000002",
);
const CONVERSATION_ID = Schema.decodeSync(conversationId)(
  "00000000-0000-4000-8000-000000000010",
);
const OTHER_CONVERSATION_ID = Schema.decodeSync(conversationId)(
  "00000000-0000-4000-8000-000000000011",
);
const LAST_ID = "00000000-0000-4000-8000-000000000020";
const NORMALIZED_QUERY = "exact-name";

function expectInvalidParams<A>(effect: Effect.Effect<A, InvalidParamsError>) {
  const result = Effect.runSync(Effect.either(effect));
  Either.match(result, {
    onLeft: (error) => {
      expect(error).toBeInstanceOf(InvalidParamsError);
    },
    onRight: () => {
      expect.fail("Expected InvalidParamsError");
    },
  });
}

function encodeTestPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

// @agent-code-guard/regression-only: fixed cursor bindings and malformed encodings are closed boundary cases rather than a generative input space.
describe("search cursor", () => {
  it("normalizes omitted and whitespace-only queries to browse", () => {
    expect(normalizeSearchQuery()).toBe("");
    expect(normalizeSearchQuery(" \t\n ")).toBe("");
    expect(normalizeSearchQuery(`  ${NORMALIZED_QUERY}  `)).toBe(
      NORMALIZED_QUERY,
    );
  });

  it("roundtrips the operation, query, caller, and last id binding", () => {
    const binding = {
      kind: "agents" as const,
      query: NORMALIZED_QUERY,
      agentId: CALLER_ID,
    };
    const cursor = encodeSearchCursor({ ...binding, lastId: LAST_ID });

    expect(Effect.runSync(decodeSearchCursor(cursor, binding))).toEqual({
      lastId: LAST_ID,
    });
  });

  it("rejects cross-operation, query, and caller reuse", () => {
    const binding = {
      kind: "agents" as const,
      query: NORMALIZED_QUERY,
      agentId: CALLER_ID,
    };
    const cursor = encodeSearchCursor({ ...binding, lastId: LAST_ID });

    expectInvalidParams(
      decodeSearchCursor(cursor, { ...binding, kind: "conversations" }),
    );
    expectInvalidParams(
      decodeSearchCursor(cursor, { ...binding, query: "different" }),
    );
    expectInvalidParams(
      decodeSearchCursor(cursor, {
        ...binding,
        agentId: OTHER_AGENT_ID,
      }),
    );
  });

  it("rejects malformed and non-canonical tokens", () => {
    const binding = {
      kind: "agents" as const,
      query: "",
      agentId: CALLER_ID,
    };
    expectInvalidParams(decodeSearchCursor("not-base64url!", binding));
    expectInvalidParams(
      decodeSearchCursor(
        encodeTestPayload({
          version: 1,
          query: "",
          lastId: LAST_ID,
          kind: "agents",
          agentId: CALLER_ID,
        }),
        binding,
      ),
    );
  });

  it("emits a continuation only when the fixed-size page overflows", () => {
    const binding = {
      kind: "agents" as const,
      query: "",
      agentId: CALLER_ID,
    };
    const rows = [...Array(READ_PLANE_PAGE_SIZE + 1).keys()].map((index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const result = paginateSearchRows(rows, binding, (row) => row.id);

    expect(result.page).toHaveLength(READ_PLANE_PAGE_SIZE);
    expect(result.nextCursor).toBeDefined();
    expect(
      Effect.runSync(
        decodeSearchCursor(
          /* Safe because this overflow fixture always produces a cursor. */
          result.nextCursor!,
          binding,
        ),
      ),
    ).toEqual({ lastId: rows[READ_PLANE_PAGE_SIZE - 1]?.id });
  });
});

// @agent-code-guard/regression-only: checkpoint and frozen-page token cases pin a finite wire boundary.
describe("conversation read positions", () => {
  it("roundtrips a conversation-bound durable checkpoint", () => {
    const checkpoint = encodeConversationCheckpoint({
      conversationId: CONVERSATION_ID,
      throughSeq: "123456789",
    });

    expect(
      Effect.runSync(decodeConversationCheckpoint(checkpoint, CONVERSATION_ID)),
    ).toEqual({ throughSeq: "123456789" });
    expectInvalidParams(
      decodeConversationCheckpoint(checkpoint, OTHER_CONVERSATION_ID),
    );
  });

  it("roundtrips a frozen page cursor and rejects an inverted interval", () => {
    const cursor = encodeConversationReadCursor({
      conversationId: CONVERSATION_ID,
      throughSeq: "200",
      afterSeq: "100",
    });
    expect(
      Effect.runSync(decodeConversationReadCursor(cursor, CONVERSATION_ID)),
    ).toEqual({ throughSeq: "200", afterSeq: "100" });

    const inverted = encodeConversationReadCursor({
      conversationId: CONVERSATION_ID,
      throughSeq: "100",
      afterSeq: "101",
    });
    expectInvalidParams(
      decodeConversationReadCursor(inverted, CONVERSATION_ID),
    );
  });

  it("rejects non-canonical decimal strings and cross-conversation reuse", () => {
    const cursor = encodeConversationReadCursor({
      conversationId: CONVERSATION_ID,
      throughSeq: "200",
      afterSeq: "100",
    });
    expectInvalidParams(
      decodeConversationReadCursor(cursor, OTHER_CONVERSATION_ID),
    );

    const checkpoint = encodeTestPayload({
      conversationId: CONVERSATION_ID,
      kind: "conversation-checkpoint",
      throughSeq: "0200",
      version: 1,
    });
    expectInvalidParams(
      decodeConversationCheckpoint(checkpoint, CONVERSATION_ID),
    );
  });
});
/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function -- Restore strict defaults after the codec scenarios. */
