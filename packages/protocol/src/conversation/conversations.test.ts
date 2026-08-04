import { describe, expect, it } from "vitest";

import { AuthenticatedAgent } from "#identity/principals";
import { ActiveAgent } from "#identity/requirements";
import { InvalidParamsError } from "#transport";
import {
  agentCallableConversationRpcMethods,
  conversationSearch,
} from "./conversations.js";

const CONVERSATION = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "planning",
  createdBy: "660e8400-e29b-41d4-a716-446655440000",
  createdAt: "2026-08-03T12:00:00.000Z",
  updatedAt: "2026-08-03T12:00:00.000Z",
};

describe("agent/conversation/search", () => {
  it("accepts the closed query and cursor contract", () => {
    expect(conversationSearch.validateParams({})).toBe(true);
    expect(conversationSearch.validateParams({ query: "" })).toBe(true);
    expect(
      conversationSearch.validateParams({
        query: "planning",
        cursor: "next-page",
      }),
    ).toBe(true);
    expect(conversationSearch.validateParams({ limit: 10 })).toBe(false);
    expect(conversationSearch.validateParams({ count: 10 })).toBe(false);
  });

  it("validates the paginated Conversation result", () => {
    expect(
      conversationSearch.validateResult({
        conversations: [CONVERSATION],
        nextCursor: "next-page",
      }),
    ).toBe(true);
    expect(conversationSearch.validateResult({ conversations: [] })).toBe(true);
    expect(conversationSearch.validateResult({ items: [CONVERSATION] })).toBe(
      false,
    );
  });

  it("declares its authority, errors, and domain catalog membership", () => {
    expect(conversationSearch.requires).toEqual([
      AuthenticatedAgent,
      ActiveAgent,
    ]);
    expect(conversationSearch.errors).toEqual([InvalidParamsError]);
    expect(agentCallableConversationRpcMethods).toContain(conversationSearch);
  });
});
