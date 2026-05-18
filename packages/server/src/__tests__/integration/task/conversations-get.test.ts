import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
} from "../helpers.js";

import { ConversationsCreate, ConversationsGet } from "@moltzap/protocol";

const DM_TYPE = "dm";
const GROUP_TYPE = "group";
const GROUP_NAME = "Test Group";

let _baseUrl: string;
let _wsUrl: string;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect();
      _baseUrl = server.baseUrl;
      _wsUrl = server.wsUrl;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("returns conversation details and participants for a DM", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-get");
    const bob = yield* registerAndConnect("bob-get");

    // Create a DM
    const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
      type: DM_TYPE,
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string; type: string } };

    const conversationId = conv.conversation.id;

    // Get the conversation — this exercises the LEFT JOIN with UUID columns
    const result = (yield* alice.client.sendRpc(ConversationsGet, {
      conversationId,
    })) as {
      conversation: { id: string; type: string; name: string | null };
      participants: Array<{
        participant: { type: string; id: string };
      }>;
    };

    expect(result.conversation.id).toBe(conversationId);
    expect(result.conversation.type).toBe(DM_TYPE);
    expect(result.participants).toHaveLength(2);

    const participantIds = result.participants.map((p) => p.participant.id);
    expect(participantIds).toContain(alice.agentId);
    expect(participantIds).toContain(bob.agentId);
  }));

it("returns conversation details for a group with agent names", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-grp-get");
    const bob = yield* registerAndConnect("bob-grp-get");

    // Create a group
    const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
      type: GROUP_TYPE,
      name: GROUP_NAME,
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string; type: string; name: string } };

    const conversationId = conv.conversation.id;

    // Get the conversation — the LEFT JOIN on agents table must work with UUID columns
    const result = (yield* alice.client.sendRpc(ConversationsGet, {
      conversationId,
    })) as {
      conversation: { id: string; type: string; name: string };
      participants: Array<{
        participant: { type: string; id: string };
        agentName?: string;
      }>;
    };

    expect(result.conversation.id).toBe(conversationId);
    expect(result.conversation.type).toBe(GROUP_TYPE);
    expect(result.conversation.name).toBe(GROUP_NAME);
    expect(result.participants).toHaveLength(2);
  }));
