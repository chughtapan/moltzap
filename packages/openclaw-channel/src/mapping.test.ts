import { describe, expect, it } from "vitest";
import type { Message, EventFrame } from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";
import {
  mapMessageToEnvelope,
  isMessageEvent,
  extractMessage,
  extractReadReceipt,
  extractReaction,
  extractDelivery,
  extractDeletion,
  extractConversationCreated,
  extractConversationUpdated,
  extractContactRequest,
  extractContactAccepted,
  extractPresenceChanged,
  extractTypingIndicator,
} from "./mapping.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    sender: { type: "user", id: "u-1" },
    seq: 0,
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

describe("mapMessageToEnvelope", () => {
  it("maps user sender to 'user' kind", () => {
    const env = mapMessageToEnvelope(
      makeMessage({ sender: { type: "user", id: "u-1" } }),
    );
    expect(env.peer.kind).toBe("user");
    expect(env.peer.id).toBe("user:u-1");
  });

  it("maps agent sender to 'bot' kind", () => {
    const env = mapMessageToEnvelope(
      makeMessage({ sender: { type: "agent", id: "a-1" } }),
    );
    expect(env.peer.kind).toBe("bot");
    expect(env.peer.id).toBe("agent:a-1");
  });

  it("joins multiple text parts with newlines", () => {
    const env = mapMessageToEnvelope(
      makeMessage({
        parts: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
      }),
    );
    expect(env.text).toBe("line1\nline2");
  });

  it("filters out non-text parts", () => {
    const env = mapMessageToEnvelope(
      makeMessage({
        parts: [
          { type: "text", text: "keep" },
          {
            type: "image",
            url: "https://img.png",
          } as unknown as Message["parts"][0],
        ],
      }),
    );
    expect(env.text).toBe("keep");
  });

  it("sets channel to 'moltzap'", () => {
    const env = mapMessageToEnvelope(makeMessage());
    expect(env.channel).toBe("moltzap");
  });

  it("sets accountId to 'default'", () => {
    const env = mapMessageToEnvelope(makeMessage());
    expect(env.accountId).toBe("default");
  });

  it("passes through conversationId", () => {
    const env = mapMessageToEnvelope(
      makeMessage({ conversationId: "conv-42" }),
    );
    expect(env.conversationId).toBe("conv-42");
  });

  it("returns empty text when all parts are non-text", () => {
    const env = mapMessageToEnvelope(
      makeMessage({
        parts: [
          {
            type: "image",
            url: "https://img.png",
          } as unknown as Message["parts"][0],
        ],
      }),
    );
    expect(env.text).toBe("");
  });

  it("includes messageId from the message", () => {
    const env = mapMessageToEnvelope(makeMessage({ id: "msg-42" }));
    expect(env.messageId).toBe("msg-42");
  });

  it("includes replyToId when present", () => {
    const env = mapMessageToEnvelope(makeMessage({ replyToId: "msg-parent" }));
    expect(env.replyToId).toBe("msg-parent");
  });

  it("omits replyToId when not present", () => {
    const env = mapMessageToEnvelope(makeMessage());
    expect(env.replyToId).toBeUndefined();
  });

  it("includes senderName when provided", () => {
    const env = mapMessageToEnvelope(makeMessage(), {
      senderName: "atlas",
    });
    expect(env.senderName).toBe("atlas");
  });

  it("omits senderName when not provided", () => {
    const env = mapMessageToEnvelope(makeMessage());
    expect(env).not.toHaveProperty("senderName");
  });

  it("includes group context fields when provided", () => {
    const env = mapMessageToEnvelope(makeMessage(), {
      chatType: "group",
      groupSubject: "Project Alpha",
      groupMembers: "agent:a-1,agent:a-2",
      conversationLabel: "Project Alpha",
    });
    expect(env.chatType).toBe("group");
    expect(env.groupSubject).toBe("Project Alpha");
    expect(env.groupMembers).toBe("agent:a-1,agent:a-2");
    expect(env.conversationLabel).toBe("Project Alpha");
  });

  it("omits group context fields when not provided", () => {
    const env = mapMessageToEnvelope(makeMessage());
    expect(env).not.toHaveProperty("chatType");
    expect(env).not.toHaveProperty("groupSubject");
    expect(env).not.toHaveProperty("groupMembers");
    expect(env).not.toHaveProperty("conversationLabel");
  });

  it("includes chatType 'direct' for DMs", () => {
    const env = mapMessageToEnvelope(makeMessage(), {
      chatType: "direct",
    });
    expect(env.chatType).toBe("direct");
  });
});

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

describe("extractReadReceipt", () => {
  it("extracts read receipt from valid frame", () => {
    const result = extractReadReceipt(
      makeEventFrame(EventNames.MessageRead, {
        conversationId: "conv-1",
        participant: { type: "agent", id: "a-1" },
        seq: 5,
      }),
    );
    expect(result).toEqual({
      conversationId: "conv-1",
      participant: { type: "agent", id: "a-1" },
      seq: 5,
    });
  });

  it("returns null for wrong event type", () => {
    expect(
      extractReadReceipt(
        makeEventFrame(EventNames.MessageReceived, {
          conversationId: "conv-1",
          participant: { type: "agent", id: "a-1" },
          seq: 5,
        }),
      ),
    ).toBeNull();
  });

  it("returns null when data is missing fields", () => {
    expect(
      extractReadReceipt(
        makeEventFrame(EventNames.MessageRead, {
          conversationId: "conv-1",
        }),
      ),
    ).toBeNull();
  });
});

describe("extractReaction", () => {
  it("extracts reaction from valid frame", () => {
    const result = extractReaction(
      makeEventFrame(EventNames.MessageReacted, {
        messageId: "msg-1",
        emoji: "thumbsup",
        participant: { type: "agent", id: "a-1" },
        action: "add",
      }),
    );
    expect(result).toEqual({
      messageId: "msg-1",
      emoji: "thumbsup",
      participant: { type: "agent", id: "a-1" },
      action: "add",
    });
  });

  it("returns null for wrong event type", () => {
    expect(
      extractReaction(
        makeEventFrame(EventNames.MessageReceived, {
          messageId: "msg-1",
          emoji: "thumbsup",
          participant: { type: "agent", id: "a-1" },
          action: "add",
        }),
      ),
    ).toBeNull();
  });

  it("returns null when data is incomplete", () => {
    expect(
      extractReaction(
        makeEventFrame(EventNames.MessageReacted, {
          messageId: "msg-1",
        }),
      ),
    ).toBeNull();
  });
});

describe("extractDelivery", () => {
  it("extracts delivery from valid frame", () => {
    const result = extractDelivery(
      makeEventFrame(EventNames.MessageDelivered, {
        messageId: "msg-1",
        conversationId: "conv-1",
        participant: { type: "agent", id: "a-1" },
      }),
    );
    expect(result).toEqual({
      messageId: "msg-1",
      conversationId: "conv-1",
      participant: { type: "agent", id: "a-1" },
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

describe("extractDeletion", () => {
  it("extracts deletion from valid frame", () => {
    const result = extractDeletion(
      makeEventFrame(EventNames.MessageDeleted, {
        messageId: "msg-1",
        conversationId: "conv-1",
      }),
    );
    expect(result).toEqual({
      messageId: "msg-1",
      conversationId: "conv-1",
    });
  });

  it("returns null for wrong event type", () => {
    expect(
      extractDeletion(makeEventFrame(EventNames.MessageReceived)),
    ).toBeNull();
  });

  it("returns null when missing conversationId", () => {
    expect(
      extractDeletion(
        makeEventFrame(EventNames.MessageDeleted, {
          messageId: "msg-1",
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
          requesterId: "u-1",
          targetId: "u-2",
          status: "pending",
        },
      }),
    );
    expect(result).toEqual({
      contact: {
        id: "c-1",
        requesterId: "u-1",
        targetId: "u-2",
        status: "pending",
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
          requesterId: "u-1",
          targetId: "u-2",
          status: "accepted",
        },
      }),
    );
    expect(result).toEqual({
      contact: {
        id: "c-1",
        requesterId: "u-1",
        targetId: "u-2",
        status: "accepted",
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
        participant: { type: "agent", id: "a-1" },
        status: "online",
      }),
    );
    expect(result).toEqual({
      participant: { type: "agent", id: "a-1" },
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
          participant: { type: "agent", id: "a-1" },
        }),
      ),
    ).toBeNull();
  });
});

describe("extractTypingIndicator", () => {
  it("extracts typing from valid frame", () => {
    const result = extractTypingIndicator(
      makeEventFrame(EventNames.TypingIndicator, {
        conversationId: "conv-1",
        participant: { type: "agent", id: "a-1" },
      }),
    );
    expect(result).toEqual({
      conversationId: "conv-1",
      participant: { type: "agent", id: "a-1" },
    });
  });

  it("returns null for wrong event type", () => {
    expect(
      extractTypingIndicator(makeEventFrame(EventNames.MessageReceived)),
    ).toBeNull();
  });

  it("returns null when missing participant", () => {
    expect(
      extractTypingIndicator(
        makeEventFrame(EventNames.TypingIndicator, {
          conversationId: "conv-1",
        }),
      ),
    ).toBeNull();
  });
});
