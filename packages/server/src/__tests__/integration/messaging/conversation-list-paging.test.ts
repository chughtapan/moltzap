import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  type ConnectedAgent,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
} from "../helpers.js";

import { type AgentId, DEFAULT_APP_ID } from "@moltzap/protocol/identity";
import {
  agentConversationCreate,
  type ConversationId,
  conversationList,
} from "@moltzap/protocol/conversation";
import { messagesSend } from "@moltzap/protocol/message";

const PAGE_SIZE = 1;
const MAX_PAGES = 4;

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

/**
 * Open a conversation between the caller and one other agent.
 * @param client Connected agent opening the conversation.
 * @param participant Agent to invite.
 * @returns The new conversation's id.
 */
function openConversation(
  client: ConnectedAgent["client"],
  participant: AgentId,
): Effect.Effect<ConversationId, unknown> {
  return client
    .sendRpc(agentConversationCreate, {
      appId: DEFAULT_APP_ID,
      participants: [participant],
    })
    .pipe(Effect.map((result) => result.conversation.id));
}

/**
 * Walk `agent/conversation/list` one conversation at a time, following
 * `nextCursor` until the server stops returning one.
 * @param client Connected agent whose conversations are listed.
 * @returns Every conversation id seen, in page order.
 */
function drainConversationPages(
  client: ConnectedAgent["client"],
): Effect.Effect<ConversationId[], unknown> {
  return Effect.gen(function* () {
    const seen: ConversationId[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = yield* client.sendRpc(conversationList, {
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((item) => item.conversation.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < MAX_PAGES);
    return seen;
  });
}

it("pages every conversation exactly once when a message reorders the oldest one", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    // Created oldest-first, so `conversations.updated_at` ascends first → third.
    const first = yield* openConversation(alice.client, bob.agentId);
    const second = yield* openConversation(alice.client, bob.agentId);
    const third = yield* openConversation(alice.client, bob.agentId);

    // A message does not touch the conversation row, so `first` now has the
    // newest activity while keeping the oldest `updated_at`. Paging on
    // `updated_at` would put it on page one and then exclude every other
    // conversation from page two.
    yield* alice.client.sendRpc(messagesSend, {
      conversationId: first,
      parts: [{ type: "text", text: "revives the oldest conversation" }],
    });

    const seen = yield* drainConversationPages(alice.client);

    expect(seen).toEqual([first, third, second]);
  }));

it("orders by last activity rather than conversation update time", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const older = yield* openConversation(alice.client, bob.agentId);
    const newer = yield* openConversation(alice.client, bob.agentId);

    yield* alice.client.sendRpc(messagesSend, {
      conversationId: older,
      parts: [{ type: "text", text: "most recent activity" }],
    });

    const page = yield* alice.client.sendRpc(conversationList, { limit: 10 });

    expect(page.items.map((item) => item.conversation.id)).toEqual([
      older,
      newer,
    ]);
  }));
