import { describe, expect, it } from "vitest";
import type {
  Conversation,
  ConversationId,
} from "@moltzap/protocol/conversation";
import type { AgentCard, AgentId } from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import {
  agentId,
  agentName,
  conversationId,
  messageId,
} from "@moltzap/protocol/testing";
import { projectHarnessTurn } from "../channel-core.js";

type ConversationWithParticipants = Conversation & {
  readonly participants: readonly AgentId[];
};

const OWN = agentId("00000000-0000-4000-8000-000000000001");
const ALICE = agentId("00000000-0000-4000-8000-000000000002");
const BOB = agentId("00000000-0000-4000-8000-000000000003");
const UNKNOWN = agentId("00000000-0000-4000-8000-000000000004");
const TARGET = conversationId("00000000-0000-4000-8000-000000000005");
const SOURCE = conversationId("00000000-0000-4000-8000-000000000006");

const agents: readonly AgentCard[] = [
  { id: ALICE, name: agentName("alice"), status: "active" },
  { id: BOB, name: agentName("bob"), status: "active" },
];

const conversation = (
  id: ConversationId,
  participants: readonly AgentId[],
  name?: string,
): ConversationWithParticipants => ({
  id,
  createdBy: OWN,
  participants,
  ...(name === undefined ? {} : { name }),
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
});

interface MessageInput {
  readonly id: string;
  readonly conversationId: ConversationId;
  readonly senderId: AgentId;
  readonly parts: Message["parts"];
  readonly createdAt: string;
}

const message = ({
  id,
  conversationId,
  senderId,
  parts,
  createdAt,
}: MessageInput): Message => ({
  id: messageId(id),
  conversationId,
  senderId,
  parts,
  createdAt,
});

interface MaterializedMessages {
  readonly first: Message;
  readonly queued: Message;
  readonly cross: Message;
}

const materializedMessages = (): MaterializedMessages => ({
  first: message({
    id: "00000000-0000-4000-8000-000000000007",
    conversationId: TARGET,
    senderId: ALICE,
    parts: [
      { type: "text", text: "first" },
      { type: "image", url: "https://example.com/first.png" },
      { type: "text", text: "continued" },
    ],
    createdAt: "2026-08-04T12:00:01.000Z",
  }),
  queued: message({
    id: "00000000-0000-4000-8000-000000000008",
    conversationId: TARGET,
    senderId: BOB,
    parts: [
      { type: "text", text: "second" },
      {
        type: "file",
        url: "https://example.com/ignored.txt",
        name: "ignored.txt",
      },
    ],
    createdAt: "2026-08-04T12:00:02.000Z",
  }),
  cross: message({
    id: "00000000-0000-4000-8000-000000000009",
    conversationId: SOURCE,
    senderId: UNKNOWN,
    parts: [
      { type: "text", text: "context" },
      {
        type: "file",
        url: "https://example.com/report.pdf",
        name: "report.pdf",
      },
      { type: "image", url: "https://example.com/chart.png" },
    ],
    createdAt: "2026-08-04T11:59:59.000Z",
  }),
});

const projectMaterializedHarnessContext = ({
  first,
  queued,
  cross,
}: MaterializedMessages) =>
  projectHarnessTurn({
    ownAgentId: OWN,
    agents,
    context: {
      currentMessages: [first, queued],
      crossConversationMessages: [cross],
      conversations: [
        conversation(TARGET, [OWN, ALICE, BOB], "builders"),
        conversation(SOURCE, [OWN, UNKNOWN], "research"),
      ],
    },
  });

const groupMetadata = {
  type: "group" as const,
  name: "builders",
  participants: [`agent:${OWN}`, `agent:${ALICE}`, `agent:${BOB}`],
};

const expectedCrossContext = (cross: Message) => ({
  groupMetadata,
  crossConversationMessages: [
    {
      conversationId: SOURCE,
      conversationName: "research",
      senderName: UNKNOWN,
      senderId: UNKNOWN,
      text: "context [file: report.pdf] [image]",
      timestamp: cross.createdAt,
    },
  ],
});

const expectedCoalescedMessages = (first: Message, queued: Message) => [
  {
    id: first.id,
    sender: { id: ALICE, name: "alice" },
    text: "first\ncontinued",
    createdAt: first.createdAt,
  },
  {
    id: queued.id,
    sender: { id: BOB, name: "bob" },
    text: "second",
    createdAt: queued.createdAt,
  },
];

const expectMaterializedProjection = (
  projected: ReturnType<typeof projectHarnessTurn>,
  { first, queued, cross }: MaterializedMessages,
) => {
  expect(projected).toEqual({
    id: first.id,
    conversationId: TARGET,
    sender: { id: ALICE, name: "alice" },
    text: "first\ncontinued\n\n[queued message from bob at 2026-08-04T12:00:02.000Z]\nsecond",
    isFromMe: false,
    createdAt: first.createdAt,
    conversationMeta: groupMetadata,
    contextBlocks: expectedCrossContext(cross),
    coalescedMessages: expectedCoalescedMessages(first, queued),
  });
};

const projectsMaterializedHarnessContext = () => {
  const messages = materializedMessages();
  expectMaterializedProjection(
    projectMaterializedHarnessContext(messages),
    messages,
  );
};

const preservesSparseDirectShape = () => {
  const ownMessage = message({
    id: "00000000-0000-4000-8000-000000000010",
    conversationId: TARGET,
    senderId: OWN,
    parts: [{ type: "text", text: "self" }],
    createdAt: "2026-08-04T12:00:03.000Z",
  });
  const projected = projectHarnessTurn({
    ownAgentId: OWN,
    agents: [],
    context: {
      currentMessages: [ownMessage],
      crossConversationMessages: [],
      conversations: [conversation(TARGET, [OWN, ALICE])],
    },
  });

  expect(projected).toEqual({
    id: ownMessage.id,
    conversationId: TARGET,
    sender: { id: OWN, name: OWN },
    text: "self",
    isFromMe: true,
    createdAt: ownMessage.createdAt,
    conversationMeta: {
      type: "dm",
      participants: [`agent:${OWN}`, `agent:${ALICE}`],
    },
    contextBlocks: {},
  });
  expect(projected).not.toHaveProperty("coalescedMessages");
  expect(projected.contextBlocks).not.toHaveProperty(
    "crossConversationMessages",
  );
};

// @agent-code-guard/regression-only: these examples pin the exact channel-owned shape reused by package-private harness projection.
describe("harness turn projection", () => {
  it("projects names, membership, cross-history, and coalesced current text", () => {
    projectsMaterializedHarnessContext();
  });
  it("preserves sparse direct-message shape and identity fallback", () => {
    preservesSparseDirectShape();
  });
});
