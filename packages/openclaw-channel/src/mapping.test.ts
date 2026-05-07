import { describe, expect, it } from "vitest";
import type { Message, NotificationFrame } from "@moltzap/protocol";
import {
  ContactAcceptedNotificationDefinition,
  ContactRequestNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  MessageReceivedNotificationDefinition,
  PresenceChangedNotificationDefinition,
  type AnyNotificationDefinition,
  type NotificationParamsOf,
} from "@moltzap/protocol";
import {
  agentId,
  contactId,
  conversationId,
  messageId,
  userId,
} from "@moltzap/protocol/testing";
import {
  isMessageNotification,
  extractMessage,
  extractConversationCreated,
  extractConversationUpdated,
  extractContactRequest,
  extractContactAccepted,
  extractPresenceChanged,
} from "./mapping.js";

const CONVERSATION_ID = conversationId("550e8400-e29b-41d4-a716-446655440102");
const AGENT_ID = agentId("550e8400-e29b-41d4-a716-446655440103");
const MESSAGE_ID = messageId("550e8400-e29b-41d4-a716-446655440101");
const CREATED_AT = "2026-01-01T00:00:00Z";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    senderId: AGENT_ID,
    parts: [{ type: "text", text: "hello" }],
    createdAt: CREATED_AT,
    ...overrides,
  } as Message;
}

function makeNotificationFrame<D extends AnyNotificationDefinition>(
  definition: D,
  params: NotificationParamsOf<D>,
): NotificationFrame {
  return definition.encode(params);
}

const MESSAGE_RECEIVED_FRAME = () =>
  makeNotificationFrame(MessageReceivedNotificationDefinition, {
    message: makeMessage(),
  });

const PRESENCE_FRAME = () =>
  makeNotificationFrame(PresenceChangedNotificationDefinition, {
    agentId: AGENT_ID,
    status: "online",
  });

const CONTACT = {
  id: contactId("550e8400-e29b-41d4-a716-446655440301"),
  contactUserId: userId("550e8400-e29b-41d4-a716-446655440302"),
};

const conversation = (type: "dm" | "group", name?: string) => ({
  id: CONVERSATION_ID,
  type,
  ...(name !== undefined ? { name } : {}),
  createdBy: AGENT_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

describe("isMessageNotification", () => {
  it("returns true for messages/received notification", () => {
    expect(isMessageNotification(MESSAGE_RECEIVED_FRAME())).toBe(true);
  });

  it("returns false for other notifications", () => {
    expect(isMessageNotification(PRESENCE_FRAME())).toBe(false);
  });
});

describe("extractMessage", () => {
  it("extracts message from a valid messages/received frame", () => {
    const msg = makeMessage();
    const frame = makeNotificationFrame(MessageReceivedNotificationDefinition, {
      message: msg,
    });
    expect(extractMessage(frame)).toEqual(msg);
  });

  it("returns null for wrong notification method", () => {
    expect(extractMessage(PRESENCE_FRAME())).toBeNull();
  });
});

describe("extractConversationCreated", () => {
  it("extracts conversation from valid frame", () => {
    const created = conversation("group", "Test Group");
    const result = extractConversationCreated(
      makeNotificationFrame(ConversationCreatedNotificationDefinition, {
        conversation: created,
      }),
    );
    expect(result).toEqual({ conversation: created });
  });

  it("returns null for wrong notification method", () => {
    expect(extractConversationCreated(MESSAGE_RECEIVED_FRAME())).toBeNull();
  });
});

describe("extractConversationUpdated", () => {
  it("extracts conversation from valid frame", () => {
    const updated = conversation("dm");
    const result = extractConversationUpdated(
      makeNotificationFrame(ConversationUpdatedNotificationDefinition, {
        conversation: updated,
      }),
    );
    expect(result).toEqual({ conversation: updated });
  });

  it("returns null for wrong notification method", () => {
    expect(extractConversationUpdated(MESSAGE_RECEIVED_FRAME())).toBeNull();
  });
});

describe("extractContactRequest", () => {
  it("extracts contact from valid frame", () => {
    const result = extractContactRequest(
      makeNotificationFrame(ContactRequestNotificationDefinition, {
        contact: CONTACT,
      }),
    );
    expect(result).toEqual({ contact: CONTACT });
  });

  it("returns null for wrong notification method", () => {
    expect(extractContactRequest(MESSAGE_RECEIVED_FRAME())).toBeNull();
  });
});

describe("extractContactAccepted", () => {
  it("extracts contact from valid frame", () => {
    const result = extractContactAccepted(
      makeNotificationFrame(ContactAcceptedNotificationDefinition, {
        contact: CONTACT,
      }),
    );
    expect(result).toEqual({ contact: CONTACT });
  });

  it("returns null for wrong notification method", () => {
    expect(extractContactAccepted(MESSAGE_RECEIVED_FRAME())).toBeNull();
  });
});

describe("extractPresenceChanged", () => {
  it("extracts presence from valid frame", () => {
    expect(extractPresenceChanged(PRESENCE_FRAME())).toEqual({
      agentId: AGENT_ID,
      status: "online",
    });
  });

  it("returns null for wrong notification method", () => {
    expect(extractPresenceChanged(MESSAGE_RECEIVED_FRAME())).toBeNull();
  });
});
