import * as fc from "fast-check";
import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  ForbiddenError,
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
} from "@moltzap/protocol";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentGroup,
} from "../helpers.js";
import type { ConnectedAgent } from "../helpers.js";
import { getCoreDb, expectRpcFailure } from "../../../test-utils/index.js";

import {
  ConversationsArchive,
  ConversationsList,
  ConversationsUnarchive,
} from "@moltzap/protocol";

const PROPERTY_RUNS = 25;
const ARCHIVE_TARGET_GROUP_NAME = "Archive Target";
const PERMISSION_GROUP_NAME = "Perm Test";
const IDEMPOTENT_GROUP_NAME = "Idempotent";
const UNARCHIVE_IDEMPOTENT_GROUP_NAME = "Unarchive Idem";
const RACE_GROUP_NAME = "Race";

interface ArchiveGroup {
  alice: ConnectedAgent;
  bob: ConnectedAgent;
  eve: ConnectedAgent;
  conversationId: string;
}

interface ConversationListResult {
  conversations: Array<{ id: string }>;
}

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("property: conversation membership lookup follows listed IDs", () => {
  expect.hasAssertions();
  fc.assert(
    fc.property(
      fc.uuid(),
      fc.array(fc.uuid(), { minLength: 0, maxLength: 8 }),
      (conversationId, ids) => {
        const list = {
          conversations: ids.map((id) => ({ id })),
        };
        expect(hasConversation(list, conversationId)).toBe(
          ids.includes(conversationId),
        );
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

it("owner archives and unarchives; broadcasts events", () =>
  Effect.gen(function* () {
    const group = yield* archiveGroup();

    yield* group.alice.client.sendRpc(ConversationsArchive, {
      conversationId: group.conversationId,
    });
    yield* expectArchivedBroadcast(group);
    yield* expectArchivedListVisibility(group.bob, group.conversationId);

    yield* group.alice.client.sendRpc(ConversationsUnarchive, {
      conversationId: group.conversationId,
    });
    yield* expectUnarchivedBroadcast(group.bob, group.conversationId);
    yield* expectConversationVisible(group.bob, group.conversationId);
  }));

it("non-owner/admin member gets 403 on archive", () =>
  Effect.gen(function* () {
    const group = yield* setupAgentGroup(2, {
      groupName: PERMISSION_GROUP_NAME,
    });
    const [, bob] = group.agents as [ConnectedAgent, ConnectedAgent];
    const conversationId = group.conversationId!;

    const err = yield* expectRpcFailure(
      bob.client.sendRpc(ConversationsArchive, { conversationId }),
      ForbiddenError.code,
    );
    expect(err.code).toBe(ForbiddenError.code);
  }));

it("archive of archived conversation is idempotent", () =>
  Effect.gen(function* () {
    const group = yield* setupAgentGroup(2, {
      groupName: IDEMPOTENT_GROUP_NAME,
    });
    const [alice] = group.agents as [ConnectedAgent, ConnectedAgent];
    const conversationId = group.conversationId!;

    const first = yield* alice.client.sendRpc(ConversationsArchive, {
      conversationId,
    });
    const second = yield* alice.client.sendRpc(ConversationsArchive, {
      conversationId,
    });
    expect(first).toEqual({});
    expect(second).toEqual({});
  }));

it("unarchive of active conversation is idempotent", () =>
  Effect.gen(function* () {
    const group = yield* setupAgentGroup(2, {
      groupName: UNARCHIVE_IDEMPOTENT_GROUP_NAME,
    });
    const [alice] = group.agents as [ConnectedAgent, ConnectedAgent];
    const conversationId = group.conversationId!;

    const result = yield* alice.client.sendRpc(ConversationsUnarchive, {
      conversationId,
    });
    expect(result).toEqual({});
  }));

// Phase 7 cutover removed `apps/create`'s session-bootstrap path that
// attached manifest conversations under the legacy `app_sessions` ⇄
// `app_session_conversations` join. The "archive returns 409 for a
// session-attached conversation" assertion has no production trigger
// until Phase 9 wires the equivalent invariant on `tasks`/TM topology.
// Tombstoned via it.todo so the suite reports the gap.
it.todo(
  "archive of task-attached conversation returns 409 (Phase 9 reactivation)",
);

it("concurrent archive by the same privileged caller is idempotent", () =>
  Effect.gen(function* () {
    const group = yield* setupAgentGroup(2, { groupName: RACE_GROUP_NAME });
    const [alice] = group.agents as [ConnectedAgent, ConnectedAgent];
    const conversationId = group.conversationId!;

    const [first, second] = yield* Effect.all(
      [
        alice.client.sendRpc(ConversationsArchive, { conversationId }),
        alice.client.sendRpc(ConversationsArchive, { conversationId }),
      ],
      { concurrency: 2 },
    );

    expect(first).toEqual({});
    expect(second).toEqual({});
    yield* expectArchivedInDb(conversationId);
  }));

function archiveGroup() {
  return Effect.gen(function* () {
    const group = yield* setupAgentGroup(3, {
      groupName: ARCHIVE_TARGET_GROUP_NAME,
    });
    const [alice, bob, eve] = group.agents as [
      ConnectedAgent,
      ConnectedAgent,
      ConnectedAgent,
    ];
    return { alice, bob, eve, conversationId: group.conversationId! };
  });
}

function expectArchivedBroadcast(group: ArchiveGroup) {
  return Effect.gen(function* () {
    const bobArchived = yield* group.bob.client.waitForNotification(
      ConversationArchivedNotificationDefinition,
    );
    const eveArchived = yield* group.eve.client.waitForNotification(
      ConversationArchivedNotificationDefinition,
    );
    const bobData = bobArchived.params as {
      conversationId: string;
      archivedAt: string;
      by: string;
    };
    expect(bobData.conversationId).toBe(group.conversationId);
    expect(bobData.by).toBe(group.alice.agentId);
    expect(bobData.archivedAt).toEqual(expect.any(String));
    expect((eveArchived.params as { by: string }).by).toBe(group.alice.agentId);
  });
}

function expectArchivedListVisibility(
  agent: ConnectedAgent,
  conversationId: string,
) {
  return Effect.gen(function* () {
    const listDefault = (yield* agent.client.sendRpc(
      ConversationsList,
      {},
    )) as ConversationListResult;
    expect(hasConversation(listDefault, conversationId)).toBe(false);

    const listInclude = (yield* agent.client.sendRpc(ConversationsList, {
      archived: "include",
    })) as ConversationListResult;
    expect(hasConversation(listInclude, conversationId)).toBe(true);

    const listOnly = (yield* agent.client.sendRpc(ConversationsList, {
      archived: "only",
    })) as ConversationListResult;
    expect(listOnly.conversations).toHaveLength(1);
    expect(listOnly.conversations[0]!.id).toBe(conversationId);
  });
}

function expectUnarchivedBroadcast(
  agent: ConnectedAgent,
  conversationId: string,
) {
  return Effect.gen(function* () {
    const unarchived = yield* agent.client.waitForNotification(
      ConversationUnarchivedNotificationDefinition,
    );
    expect(
      (unarchived.params as { conversationId: string }).conversationId,
    ).toBe(conversationId);
  });
}

function expectConversationVisible(
  agent: ConnectedAgent,
  conversationId: string,
) {
  return Effect.gen(function* () {
    const list = (yield* agent.client.sendRpc(
      ConversationsList,
      {},
    )) as ConversationListResult;
    expect(hasConversation(list, conversationId)).toBe(true);
  });
}

function expectArchivedInDb(conversationId: string) {
  const db = getCoreDb();
  return Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      db
        .selectFrom("conversations")
        .select("archived_at")
        .where("id", "=", conversationId)
        .executeTakeFirst(),
    );
    expect(row?.archived_at).not.toBeNull();
  });
}

function hasConversation(
  list: ConversationListResult,
  conversationId: string,
): boolean {
  return list.conversations.some(
    (conversation) => conversation.id === conversationId,
  );
}
