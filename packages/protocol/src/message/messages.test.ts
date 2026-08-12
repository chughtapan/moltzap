import { describe, expect, it } from "vitest";

import { AuthenticatedAgent } from "#identity/principals";
import { ActiveAgent } from "#identity/requirements";
import { ForbiddenError, InvalidParamsError } from "#transport";
import { agentCallableMessageRpcMethods, messagesRead } from "./messages.js";

const CONVERSATION_ID = "550e8400-e29b-41d4-a716-446655440000";
const MESSAGE = {
  id: "660e8400-e29b-41d4-a716-446655440000",
  conversationId: CONVERSATION_ID,
  senderId: "770e8400-e29b-41d4-a716-446655440000",
  parts: [{ type: "text", text: "Hello!" }],
  createdAt: "2026-08-03T12:00:00.000Z",
};

describe("agent/message/read", () => {
  it("accepts the closed conversation, checkpoint, and cursor contract", () => {
    expect(
      messagesRead.validateParams({ conversationId: CONVERSATION_ID }),
    ).toBe(true);
    expect(
      messagesRead.validateParams({
        conversationId: CONVERSATION_ID,
        checkpoint: "checkpoint-1",
        cursor: "next-page",
      }),
    ).toBe(true);
    expect(
      messagesRead.validateParams({
        conversationId: CONVERSATION_ID,
        limit: 10,
      }),
    ).toBe(false);
    expect(
      messagesRead.validateParams({
        conversationId: CONVERSATION_ID,
        count: 10,
      }),
    ).toBe(false);
  });

  it("requires a checkpoint in the paginated Message result", () => {
    expect(
      messagesRead.validateResult({
        messages: [MESSAGE],
        checkpoint: "checkpoint-2",
        nextCursor: "next-page",
      }),
    ).toBe(true);
    expect(
      messagesRead.validateResult({ messages: [], checkpoint: "checkpoint-2" }),
    ).toBe(true);
    expect(messagesRead.validateResult({ messages: [] })).toBe(false);
  });

  it("declares its authority, errors, and domain catalog membership", () => {
    expect(messagesRead.requires).toEqual([AuthenticatedAgent, ActiveAgent]);
    expect(messagesRead.errors).toEqual([InvalidParamsError, ForbiddenError]);
    expect(agentCallableMessageRpcMethods).toContain(messagesRead);
  });
});
