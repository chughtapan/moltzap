import * as fc from "fast-check";
import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  ForbiddenError,
  TaskConversationArchive,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationList,
  TaskConversationUnarchive,
  TaskConversationUnarchivedNotificationDefinition,
  type ConversationId,
  type TaskId,
} from "@moltzap/protocol";
import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentGroup,
} from "../helpers.js";
import type { ConnectedAgent } from "../helpers.js";
import { getCoreDb, expectRpcFailure } from "../../../test-utils/index.js";

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
  taskId: TaskId;
  conversationId: ConversationId;
}

interface ListItem {
  readonly conversation: { readonly id: string; readonly archivedAt?: string };
}

function conversationStub(id: string): ListItem {
  return { conversation: { id } };
}

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("property: conversation membership lookup follows listed IDs", () =>
  Effect.sync(() => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.array(fc.uuid(), { minLength: 0, maxLength: 8 }),
        (conversationId, ids) => {
          const items = ids.map(conversationStub);
          expect(hasConversation(items, conversationId)).toBe(
            ids.includes(conversationId),
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  }));

it("owner archives and unarchives; broadcasts events", () =>
  Effect.gen(function* () {
    const group = yield* archiveGroup();

    yield* group.alice.client.sendRpc(TaskConversationArchive, {
      taskId: group.taskId,
      conversationId: group.conversationId,
    });
    yield* expectArchivedBroadcast(group);
    yield* expectArchivedListVisibility(group.bob, group.conversationId);

    yield* group.alice.client.sendRpc(TaskConversationUnarchive, {
      taskId: group.taskId,
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
    const taskId = group.taskId!;
    const conversationId = group.conversationId!;

    const err = yield* expectRpcFailure(
      bob.client.sendRpc(TaskConversationArchive, { taskId, conversationId }),
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
    const taskId = group.taskId!;
    const conversationId = group.conversationId!;

    const first = yield* alice.client.sendRpc(TaskConversationArchive, {
      taskId,
      conversationId,
    });
    const second = yield* alice.client.sendRpc(TaskConversationArchive, {
      taskId,
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
    const taskId = group.taskId!;
    const conversationId = group.conversationId!;

    const result = yield* alice.client.sendRpc(TaskConversationUnarchive, {
      taskId,
      conversationId,
    });
    expect(result).toEqual({});
  }));

it("archive of task-attached conversation succeeds for the owner", () =>
  Effect.gen(function* () {
    const group = yield* archiveGroup();
    const taskId = yield* readConversationTaskId(group.conversationId);
    expect(taskId).toEqual(expect.any(String));

    const result = yield* group.alice.client.sendRpc(TaskConversationArchive, {
      taskId: group.taskId,
      conversationId: group.conversationId,
    });
    expect(result).toEqual({});
    yield* expectArchivedInDb(group.conversationId);
  }));

it("concurrent archive by the same privileged caller is idempotent", () =>
  Effect.gen(function* () {
    const group = yield* setupAgentGroup(2, { groupName: RACE_GROUP_NAME });
    const [alice] = group.agents as [ConnectedAgent, ConnectedAgent];
    const taskId = group.taskId!;
    const conversationId = group.conversationId!;

    const [first, second] = yield* Effect.all(
      [
        alice.client.sendRpc(TaskConversationArchive, {
          taskId,
          conversationId,
        }),
        alice.client.sendRpc(TaskConversationArchive, {
          taskId,
          conversationId,
        }),
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
    return {
      alice,
      bob,
      eve,
      taskId: group.taskId!,
      conversationId: group.conversationId!,
    };
  });
}

function expectArchivedBroadcast(group: ArchiveGroup) {
  return Effect.gen(function* () {
    const bobArchived = yield* awaitOneNotification(
      group.bob.client,
      TaskConversationArchivedNotificationDefinition,
    );
    const eveArchived = yield* awaitOneNotification(
      group.eve.client,
      TaskConversationArchivedNotificationDefinition,
    );
    expect(bobArchived.params.conversationId).toBe(group.conversationId);
    expect(bobArchived.params.taskId).toBe(group.taskId);
    expect(bobArchived.params.archivedAt).toEqual(expect.any(String));
    expect(eveArchived.params.conversationId).toBe(group.conversationId);
  });
}

function expectArchivedListVisibility(
  agent: ConnectedAgent,
  conversationId: ConversationId,
) {
  return Effect.gen(function* () {
    const list = yield* agent.client.sendRpc(TaskConversationList, {});
    const found = list.items.find(
      (item) => item.conversation.id === conversationId,
    );
    expect(found).toBeDefined();
    expect(found!.conversation.archivedAt).toEqual(expect.any(String));
  });
}

function expectUnarchivedBroadcast(
  agent: ConnectedAgent,
  conversationId: ConversationId,
) {
  return Effect.gen(function* () {
    const unarchived = yield* awaitOneNotification(
      agent.client,
      TaskConversationUnarchivedNotificationDefinition,
    );
    expect(unarchived.params.conversationId).toBe(conversationId);
  });
}

function expectConversationVisible(
  agent: ConnectedAgent,
  conversationId: ConversationId,
) {
  return Effect.gen(function* () {
    const list = yield* agent.client.sendRpc(TaskConversationList, {});
    const found = list.items.find(
      (item) => item.conversation.id === conversationId,
    );
    expect(found).toBeDefined();
    expect(found!.conversation.archivedAt).toBeUndefined();
  });
}

function expectArchivedInDb(conversationId: ConversationId) {
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

function readConversationTaskId(conversationId: ConversationId) {
  const db = getCoreDb();
  return Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      db
        .selectFrom("conversations")
        .select("task_id")
        .where("id", "=", conversationId)
        .executeTakeFirstOrThrow(),
    );
    return row.task_id;
  });
}

function hasConversation(
  items: ReadonlyArray<ListItem>,
  conversationId: string,
): boolean {
  return items.some((item) => item.conversation.id === conversationId);
}
