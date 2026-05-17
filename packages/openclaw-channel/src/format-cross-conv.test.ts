import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  formatCrossConvOpenClaw,
  CROSS_CONV_HEADER,
} from "./format-cross-conv.js";
import type { CrossConvMessage } from "@moltzap/client";

const OWN_AGENT_ID = "agent-self";
const DIRECT_CONVERSATION_ID = "conv-dm-1";
const GROUP_CONVERSATION_ID = "conv-1";
const FALLBACK_CONVERSATION_ID = "conv-2";
const SELLER_NAME = "Seller";
const SELLER_ID = "agent-seller";
const SELLER_PRICE_TEXT = "My minimum price is $4,000/month.";
const SELLER_SHORT_PRICE_TEXT = "My price is $4K.";
const SELLER_TIMESTAMP = "2026-04-13T22:28:00Z";
const SELF_AGENT_NAME = "self-agent";
const ACKNOWLEDGED_TEXT = "Acknowledged.";
const ACKNOWLEDGED_TIMESTAMP = "2026-04-13T22:28:05Z";
const WEREWOLF_DEN_NAME = "Werewolf Den";
const BOB_NAME = "Bob";
const BOB_ID = "agent-bob";
const BOB_TARGET_TEXT = "Let's target Alice.";
const CHRONO_FIRST_ID = "a";
const CHRONO_SECOND_ID = "b";
const CHRONO_FIRST_SENDER = "A";
const CHRONO_SECOND_SENDER = "B";
const CHRONO_FIRST_TEXT = "first";
const CHRONO_SECOND_TEXT = "second";
const CHRONO_THIRD_TEXT = "third";
const CHRONO_FIRST_TIMESTAMP = "2026-04-13T22:00:00Z";
const CHRONO_SECOND_TIMESTAMP = "2026-04-13T22:00:01Z";
const CHRONO_THIRD_TIMESTAMP = "2026-04-13T22:00:02Z";

const SELLER_SENDER_JSON = '"sender": "Seller"';
const SELLER_TEXT_JSON = '"text": "My minimum price is $4,000/month."';
const SELLER_TIMESTAMP_JSON = '"timestamp": "2026-04-13T22:28:00Z"';
const YOU_SENDER_JSON = '"sender": "You"';
const WEREWOLF_CONVERSATION_JSON = '"conversation": "Werewolf Den"';
const SELLER_DM_CONVERSATION_JSON = '"conversation": "DM with @Seller"';

describe("formatCrossConvOpenClaw", () => {
  it("formats messages as OpenClaw-native JSON metadata blocks", formatsJson);

  it("replaces own agent ID with 'You' in sender field", formatsOwnSender);

  it("preserves chronological order", preservesChronologicalOrder);

  it(
    "uses conversation name when available, falls back to DM with @sender",
    formatsConversationNames,
  );

  it(
    "property: empty message lists do not emit metadata",
    emptyMessagesAreNull,
  );
});

function formatsJson() {
  const result = formatCrossConvOpenClaw([sellerMessage()], {
    ownAgentId: OWN_AGENT_ID,
  });
  expect(result).toContain(CROSS_CONV_HEADER);
  expect(result).toContain(SELLER_SENDER_JSON);
  expect(result).toContain(SELLER_TEXT_JSON);
  expect(result).toContain(SELLER_TIMESTAMP_JSON);
}

function formatsOwnSender() {
  const result = formatCrossConvOpenClaw([ownMessage()], {
    ownAgentId: OWN_AGENT_ID,
  });
  expect(result).toContain(YOU_SENDER_JSON);
}

function preservesChronologicalOrder() {
  const result = formatCrossConvOpenClaw(chronologicalMessages(), {
    ownAgentId: OWN_AGENT_ID,
  });
  expect(result).toBeDefined();
  if (result === null) return;
  const firstIdx = result.indexOf(CHRONO_FIRST_TEXT);
  const secondIdx = result.indexOf(CHRONO_SECOND_TEXT);
  const thirdIdx = result.indexOf(CHRONO_THIRD_TEXT);
  expect(firstIdx).toBeLessThan(secondIdx);
  expect(secondIdx).toBeLessThan(thirdIdx);
}

function formatsConversationNames() {
  const result = formatCrossConvOpenClaw(conversationNameMessages(), {
    ownAgentId: OWN_AGENT_ID,
  });
  expect(result).toBeDefined();
  if (result === null) return;
  expect(result).toContain(WEREWOLF_CONVERSATION_JSON);
  expect(result).toContain(SELLER_DM_CONVERSATION_JSON);
}

function emptyMessagesAreNull() {
  fc.assert(
    fc.property(fc.string(), (ownAgentId) => {
      const result = formatCrossConvOpenClaw([], { ownAgentId });
      expect(result).toBeNull();
    }),
  );
}

function sellerMessage(): CrossConvMessage {
  return {
    conversationId: DIRECT_CONVERSATION_ID,
    conversationName: undefined,
    senderName: SELLER_NAME,
    senderId: SELLER_ID,
    text: SELLER_PRICE_TEXT,
    timestamp: SELLER_TIMESTAMP,
  };
}

function ownMessage(): CrossConvMessage {
  return {
    conversationId: DIRECT_CONVERSATION_ID,
    senderName: SELF_AGENT_NAME,
    senderId: OWN_AGENT_ID,
    text: ACKNOWLEDGED_TEXT,
    timestamp: ACKNOWLEDGED_TIMESTAMP,
  };
}

function chronologicalMessages(): CrossConvMessage[] {
  return [
    {
      conversationId: CHRONO_FIRST_ID,
      senderName: CHRONO_FIRST_SENDER,
      senderId: CHRONO_FIRST_ID,
      text: CHRONO_FIRST_TEXT,
      timestamp: CHRONO_FIRST_TIMESTAMP,
    },
    {
      conversationId: CHRONO_SECOND_ID,
      senderName: CHRONO_SECOND_SENDER,
      senderId: CHRONO_SECOND_ID,
      text: CHRONO_SECOND_TEXT,
      timestamp: CHRONO_SECOND_TIMESTAMP,
    },
    {
      conversationId: CHRONO_FIRST_ID,
      senderName: CHRONO_FIRST_SENDER,
      senderId: CHRONO_FIRST_ID,
      text: CHRONO_THIRD_TEXT,
      timestamp: CHRONO_THIRD_TIMESTAMP,
    },
  ];
}

function conversationNameMessages(): CrossConvMessage[] {
  return [
    {
      conversationId: GROUP_CONVERSATION_ID,
      conversationName: WEREWOLF_DEN_NAME,
      senderName: BOB_NAME,
      senderId: BOB_ID,
      text: BOB_TARGET_TEXT,
      timestamp: CHRONO_FIRST_TIMESTAMP,
    },
    {
      conversationId: FALLBACK_CONVERSATION_ID,
      conversationName: undefined,
      senderName: SELLER_NAME,
      senderId: SELLER_ID,
      text: SELLER_SHORT_PRICE_TEXT,
      timestamp: CHRONO_SECOND_TIMESTAMP,
    },
  ];
}
