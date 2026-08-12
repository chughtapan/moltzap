/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks -- Each integration scenario keeps its RPC setup, call sequence, and wire assertions together so cursor bindings and visibility remain auditable. */
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { Effect, Either } from "effect";
import { agentsSearch, type AgentId } from "@moltzap/protocol/identity";
import { conversationSearch } from "@moltzap/protocol/conversation";
import { InvalidParamsError } from "@moltzap/protocol/rpc";
import {
  createTestAgent,
  getKyselyDb,
  it,
  resetTestDbEffect,
  setupAgentGroup,
  setupAgentPair,
  startTestServerEffect,
  stopTestServerEffect,
} from "./helpers.js";

const SEARCH_PAGE_SIZE = 50;

beforeAll(() => Effect.runPromise(startTestServerEffect()));
afterAll(() => Effect.runPromise(stopTestServerEffect()));
beforeEach(() => Effect.runPromise(resetTestDbEffect()));

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function expectInvalidParams<A>(result: Either.Either<A, unknown>): void {
  Either.match(result, {
    onLeft: (error) => {
      expect(error).toBeInstanceOf(InvalidParamsError);
    },
    onRight: () => {
      expect.fail("Expected InvalidParamsError");
    },
  });
}

function insertConversation(creator: AgentId, members: readonly AgentId[]) {
  return Effect.gen(function* () {
    const db = getKyselyDb();
    const created = yield* db
      .insertInto("conversations")
      .values({ created_by_id: creator })
      .returning("id");
    const row = created[0];
    if (row === undefined) {
      return yield* Effect.die("Conversation insert returned no row");
    }
    yield* db.insertInto("conversation_participants").values(
      [...new Set([creator, ...members])].map((agentId) => ({
        conversation_id: row.id,
        agent_id: agentId,
      })),
    );
    return row.id;
  });
}

function insertConversations(
  creator: AgentId,
  members: readonly AgentId[],
  count: number,
) {
  return Effect.forEach(
    [...Array(count).keys()],
    () => insertConversation(creator, members),
    { concurrency: 1 },
  );
}

describe(agentsSearch.name, () => {
  it("browses on blank queries and matches exact ids and names", () =>
    Effect.gen(function* () {
      const { agents } = yield* setupAgentGroup(3);
      const [alice, bob, carol] = agents;
      if (alice === undefined || bob === undefined || carol === undefined) {
        return yield* Effect.die("Expected three connected agents");
      }

      const browse = yield* alice.client.sendRpc(agentsSearch, {});
      const whitespace = yield* alice.client.sendRpc(agentsSearch, {
        query: " \t ",
      });
      const byId = yield* alice.client.sendRpc(agentsSearch, {
        query: carol.agentId,
      });
      const byName = yield* alice.client.sendRpc(agentsSearch, {
        query: bob.name,
      });
      const unknown = yield* alice.client.sendRpc(agentsSearch, {
        query: "unknown-agent",
      });

      const expectedIds = sorted(agents.map((agent) => agent.agentId));
      expect(browse.agents.map((agent) => agent.id)).toEqual(expectedIds);
      expect(whitespace.agents.map((agent) => agent.id)).toEqual(expectedIds);
      expect(byId.agents.map((agent) => agent.id)).toEqual([carol.agentId]);
      expect(byName.agents.map((agent) => agent.id)).toEqual([bob.agentId]);
      expect(unknown.agents).toEqual([]);
    }));

  it("pages in stable id order and rejects cursor binding mismatches", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupAgentPair();
      const extra = yield* Effect.forEach(
        [...Array(SEARCH_PAGE_SIZE - 1).keys()],
        (index) =>
          createTestAgent(`search-extra-${String(index).padStart(2, "0")}`),
        { concurrency: 1 },
      );

      const first = yield* alice.client.sendRpc(agentsSearch, {});
      expect(first.agents).toHaveLength(SEARCH_PAGE_SIZE);
      expect(first.nextCursor).toBeDefined();
      const cursor = first.nextCursor;
      if (cursor === undefined) {
        return yield* Effect.die("Expected overflowing agent search page");
      }
      const second = yield* alice.client.sendRpc(agentsSearch, { cursor });
      const allIds = [
        alice.agentId,
        bob.agentId,
        ...extra.map((agent) => agent.agentId),
      ];
      expect([
        ...first.agents.map((agent) => agent.id),
        ...second.agents.map((agent) => agent.id),
      ]).toEqual(sorted(allIds));
      expect(second.nextCursor).toBeUndefined();

      expectInvalidParams(
        yield* Effect.either(
          alice.client.sendRpc(agentsSearch, {
            query: alice.name,
            cursor,
          }),
        ),
      );
      expectInvalidParams(
        yield* Effect.either(bob.client.sendRpc(agentsSearch, { cursor })),
      );
      expectInvalidParams(
        yield* Effect.either(
          alice.client.sendRpc(conversationSearch, { cursor }),
        ),
      );
    }));
});
describe(conversationSearch.name, () => {
  it("matches exact conversation and current-member tokens within visibility", () =>
    Effect.gen(function* () {
      const { agents } = yield* setupAgentGroup(3);
      const [alice, bob, carol] = agents;
      if (alice === undefined || bob === undefined || carol === undefined) {
        return yield* Effect.die("Expected three connected agents");
      }
      const aliceBob = yield* insertConversation(alice.agentId, [bob.agentId]);
      const aliceCarol = yield* insertConversation(alice.agentId, [
        carol.agentId,
      ]);
      const bobCarol = yield* insertConversation(bob.agentId, [carol.agentId]);
      const group = yield* insertConversation(alice.agentId, [
        bob.agentId,
        carol.agentId,
      ]);

      const browse = yield* alice.client.sendRpc(conversationSearch, {});
      const whitespace = yield* alice.client.sendRpc(conversationSearch, {
        query: "  ",
      });
      const byConversation = yield* alice.client.sendRpc(conversationSearch, {
        query: aliceCarol,
      });
      const byMemberId = yield* alice.client.sendRpc(conversationSearch, {
        query: bob.agentId,
      });
      const byMemberName = yield* alice.client.sendRpc(conversationSearch, {
        query: bob.name,
      });
      const hidden = yield* alice.client.sendRpc(conversationSearch, {
        query: bobCarol,
      });
      const unknown = yield* alice.client.sendRpc(conversationSearch, {
        query: "unknown-member",
      });

      const visible = sorted([aliceBob, aliceCarol, group]);
      const withBob = sorted([aliceBob, group]);
      expect(
        browse.conversations.map((conversation) => conversation.id),
      ).toEqual(visible);
      expect(
        whitespace.conversations.map((conversation) => conversation.id),
      ).toEqual(visible);
      expect(
        byConversation.conversations.map((conversation) => conversation.id),
      ).toEqual([aliceCarol]);
      expect(
        byMemberId.conversations.map((conversation) => conversation.id),
      ).toEqual(withBob);
      expect(
        byMemberName.conversations.map((conversation) => conversation.id),
      ).toEqual(withBob);
      expect(hidden.conversations).toEqual([]);
      expect(unknown.conversations).toEqual([]);
    }));

  it("pages visible conversations by id and binds the cursor to the caller", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupAgentPair();
      const ids = yield* insertConversations(
        alice.agentId,
        [bob.agentId],
        SEARCH_PAGE_SIZE + 1,
      );

      const first = yield* alice.client.sendRpc(conversationSearch, {});
      expect(first.conversations).toHaveLength(SEARCH_PAGE_SIZE);
      expect(first.nextCursor).toBeDefined();
      const cursor = first.nextCursor;
      if (cursor === undefined) {
        return yield* Effect.die(
          "Expected overflowing conversation search page",
        );
      }
      const second = yield* alice.client.sendRpc(conversationSearch, {
        cursor,
      });
      expect([
        ...first.conversations.map((conversation) => conversation.id),
        ...second.conversations.map((conversation) => conversation.id),
      ]).toEqual(sorted(ids));
      expect(second.nextCursor).toBeUndefined();

      expectInvalidParams(
        yield* Effect.either(
          bob.client.sendRpc(conversationSearch, { cursor }),
        ),
      );
    }));
});
/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks -- Restore strict defaults after the integration scenarios. */
