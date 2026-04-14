import { describe, expect, it } from "vitest";
import type { Message, EventFrame } from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";
import {
  isMessageEvent,
  extractMessage,
  extractDelivery,
  extractConversationCreated,
  extractConversationUpdated,
  extractContactRequest,
  extractContactAccepted,
  extractPresenceChanged,
} from "./mapping.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    senderId: "u-1",

    parts: [{ type: "text", text: "hello" }],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Message;
}

function makeEventFrame(event: string, data?: unknown): EventFrame {
  return {
    jsonrpc: "2.0",
    type: "event",
    event,
    data,
  } as EventFrame;
}

describe("isMessageEvent", () => {
  it("returns true for messages/received event", () => {
    expect(isMessageEvent(makeEventFrame(EventNames.MessageReceived))).toBe(
      true,
    );
  });

  it("returns false for other events", () => {
    expect(isMessageEvent(makeEventFrame(EventNames.PresenceChanged))).toBe(
      false,
    );
  });
});

describe("extractMessage", () => {
  it("extracts message from a valid messages/received frame", () => {
    const msg = makeMessage();
    const frame = makeEventFrame(EventNames.MessageReceived, {
      message: msg,
    });
    expect(extractMessage(frame)).toEqual(msg);
  });

  it("returns null for wrong event type", () => {
    const frame = makeEventFrame(EventNames.PresenceChanged, {
      message: makeMessage(),
    });
    expect(extractMessage(frame)).toBeNull();
  });

  it("returns null when data is missing", () => {
    const frame = makeEventFrame(EventNames.MessageReceived);
    expect(extractMessage(frame)).toBeNull();
  });

  it("returns null when data has no message field", () => {
    const frame = makeEventFrame(EventNames.MessageReceived, {
      other: "stuff",
    });
    expect(extractMessage(frame)).toBeNull();
  });
});

describe("extractDelivery", () => {
  it("extracts delivery from valid frame", () => {
    const result = extractDelivery(
      makeEventFrame(EventNames.MessageDelivered, {
        messageId: "msg-1",
        conversationId: "conv-1",
        agentId: "a-1",
      }),
    );
    expect(result).toEqual({
      messageId: "msg-1",
      conversationId: "conv-1",
      agentId: "a-1",
    });
  });

  it("returns null for wrong event type", () => {
    expect(
      extractDelivery(makeEventFrame(EventNames.MessageReceived)),
    ).toBeNull();
  });

  it("returns null when missing participant", () => {
    expect(
      extractDelivery(
        makeEventFrame(EventNames.MessageDelivered, {
          messageId: "msg-1",
          conversationId: "conv-1",
        }),
      ),
    ).toBeNull();
  });
});

describe("extractConversationCreated", () => {
  it("extracts conversation from valid frame", () => {
    const result = extractConversationCreated(
      makeEventFrame(EventNames.ConversationCreated, {
        conversation: { id: "conv-1", type: "group", name: "Test Group" },
      }),
    );
    expect(result).toEqual({
      conversation: { id: "conv-1", type: "group", name: "Test Group" },
    });
  });

  it("returns null for wrong event type", () => {
    expect(
      extractConversationCreated(makeEventFrame(EventNames.MessageReceived)),
    ).toBeNull();
  });

  it("returns null when data has no conversation", () => {
    expect(
      extractConversationCreated(
        makeEventFrame(EventNames.ConversationCreated, { other: "stuff" }),
      ),
    ).toBeNull();
  });
});

describe("extractConversationUpdated", () => {
  it("extracts conversation from valid frame", () => {
    const result = extractConversationUpdated(
      makeEventFrame(EventNames.ConversationUpdated, {
        conversation: { id: "conv-1", type: "dm" },
      }),
    );
    expect(result).toEqual({
      conversation: { id: "conv-1", type: "dm" },
    });
  });

  it("returns null for wrong event type", () => {
    expect(
      extractConversationUpdated(makeEventFrame(EventNames.MessageReceived)),
    ).toBeNull();
  });
});

describe("extractContactRequest", () => {
  it("extracts contact from valid frame", () => {
    const result = extractContactRequest(
      makeEventFrame(EventNames.ContactRequest, {
        contact: {
          id: "c-1",
          contactUserId: "u-2",
          source: "manual",
        },
      }),
    );
    expect(result).toEqual({
      contact: {
        id: "c-1",
        contactUserId: "u-2",
        source: "manual",
      },
    });
  });

  it("returns null for wrong event type", () => {
    expect(
      extractContactRequest(makeEventFrame(EventNames.MessageReceived)),
    ).toBeNull();
  });

  it("returns null when data has no contact", () => {
    expect(
      extractContactRequest(
        makeEventFrame(EventNames.ContactRequest, { other: "data" }),
      ),
    ).toBeNull();
  });
});

describe("extractContactAccepted", () => {
  it("extracts contact from valid frame", () => {
    const result = extractContactAccepted(
      makeEventFrame(EventNames.ContactAccepted, {
        contact: {
          id: "c-1",
          contactUserId: "u-2",
          source: "manual",
        },
      }),
    );
    expect(result).toEqual({
      contact: {
        id: "c-1",
        contactUserId: "u-2",
        source: "manual",
      },
    });
  });

  it("returns null for wrong event type", () => {
    expect(
      extractContactAccepted(makeEventFrame(EventNames.MessageReceived)),
    ).toBeNull();
  });
});

describe("extractPresenceChanged", () => {
  it("extracts presence from valid frame", () => {
    const result = extractPresenceChanged(
      makeEventFrame(EventNames.PresenceChanged, {
        agentId: "a-1",
        status: "online",
      }),
    );
    expect(result).toEqual({
      agentId: "a-1",
      status: "online",
    });
  });

  it("returns null for wrong event type", () => {
    expect(
      extractPresenceChanged(makeEventFrame(EventNames.MessageReceived)),
    ).toBeNull();
  });

  it("returns null when missing status", () => {
    expect(
      extractPresenceChanged(
        makeEventFrame(EventNames.PresenceChanged, {
          agentId: "a-1",
        }),
      ),
    ).toBeNull();
  });
});
