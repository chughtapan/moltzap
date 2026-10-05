/** @file Exact wire grammar of the owner management address schemas. */

import { Encoding, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  managementSearchConversationsRequestSchema,
  managementSearchConversationsResultSchema,
} from "./owner-tools.js";

const conversationId = `cnv_${Encoding.encodeBase64Url(new Uint8Array(32).fill(1))}`;

// @agent-code-guard/regression-only: the wire schema accepts only address cursors and canonical pages.
describe("management address schemas", () => {
  it("accepts canonical address cursors and rejects excess fields", () => {
    expect(
      Schema.decodeUnknownSync(managementSearchConversationsRequestSchema)({
        afterAddress: "agent:bob",
      }),
    ).toEqual({ afterAddress: "agent:bob" });
    expect(() =>
      Schema.decodeUnknownSync(managementSearchConversationsRequestSchema)({
        afterConversationId: conversationId,
      }),
    ).toThrow();
  });

  it("requires strictly ordered address pages", () => {
    expect(
      Schema.decodeUnknownSync(managementSearchConversationsResultSchema)({
        kind: "page",
        addresses: ["agent:bob", "group:alice,bob,carol"],
        hasMore: false,
      }),
    ).toEqual({
      kind: "page",
      addresses: ["agent:bob", "group:alice,bob,carol"],
      hasMore: false,
    });
    expect(() =>
      Schema.decodeUnknownSync(managementSearchConversationsResultSchema)({
        kind: "page",
        addresses: ["group:alice,bob,carol", "agent:bob"],
        hasMore: false,
      }),
    ).toThrow();
  });
});
