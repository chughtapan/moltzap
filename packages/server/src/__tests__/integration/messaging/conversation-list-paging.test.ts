import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  type ConnectedAgent,
  expectEitherLeft,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
} from "../helpers.js";

import type { AgentId } from "@moltzap/protocol/identity";
import {
  agentConversationCreate,
  type ConversationId,
  conversationList,
} from "@moltzap/protocol/conversation";

const PAGE_SIZE = 1;
const CONVERSATION_COUNT = 3;
const PAGE_CEILING = CONVERSATION_COUNT + 1;

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
    } while (cursor !== undefined && pages < PAGE_CEILING);
    return seen;
  });
}

// The page orders on `(updated_at, id)` and the cursor pages on the same pair.
// When those two disagree a conversation can cross the page boundary between
// requests and never appear on any page.
it("returns every conversation exactly once across single-item pages", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const first = yield* openConversation(alice.client, bob.agentId);
    const second = yield* openConversation(alice.client, bob.agentId);
    const third = yield* openConversation(alice.client, bob.agentId);

    const seen = yield* drainConversationPages(alice.client);

    expect(seen).toEqual([third, second, first]);
    expect(new Set(seen).size).toBe(CONVERSATION_COUNT);
  }));

it("returns a single page whole when the limit covers every conversation", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const first = yield* openConversation(alice.client, bob.agentId);
    const second = yield* openConversation(alice.client, bob.agentId);

    const page = yield* alice.client.sendRpc(conversationList, { limit: 10 });

    expect(page.items.map((item) => item.conversation.id)).toEqual([
      second,
      first,
    ]);
    expect(page.nextCursor).toBeUndefined();
  }));

it("rejects a cursor that is not a timestamp and conversation id", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    yield* openConversation(alice.client, bob.agentId);

    const result = yield* Effect.either(
      alice.client.sendRpc(conversationList, {
        limit: PAGE_SIZE,
        cursor: "not-a-cursor",
      }),
    );

    expect(expectEitherLeft(result)).toBeDefined();
  }));
