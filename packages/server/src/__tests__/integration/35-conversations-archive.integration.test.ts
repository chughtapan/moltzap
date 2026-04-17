import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { ErrorCodes } from "@moltzap/protocol";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  setupAgentGroup,
  registerAndConnect,
} from "./helpers.js";
import type { ConnectedAgent } from "./helpers.js";
import type { CoreApp } from "../../app/types.js";
import { getCoreDb, expectRpcFailure } from "../../test-utils/index.js";

let coreApp: CoreApp;

beforeAll(async () => {
  const server = await startTestServer();
  coreApp = server.coreApp;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("conversations/archive + /unarchive", () => {
  it.live("owner archives and unarchives; broadcasts events", () =>
    Effect.gen(function* () {
      const group = yield* setupAgentGroup(3, { groupName: "Archive Target" });
      const [alice, bob, eve] = group.agents as [
        ConnectedAgent,
        ConnectedAgent,
        ConnectedAgent,
      ];
      const conversationId = group.conversationId!;

      yield* alice.client.sendRpc("conversations/archive", { conversationId });

      const bobArchived = yield* bob.client.waitForEvent(
        "conversations/archived",
      );
      const eveArchived = yield* eve.client.waitForEvent(
        "conversations/archived",
      );
      const bobData = bobArchived.data as {
        conversationId: string;
        archivedAt: string;
        by: string;
      };
      expect(bobData.conversationId).toBe(conversationId);
      expect(bobData.by).toBe(alice.agentId);
      expect(typeof bobData.archivedAt).toBe("string");
      expect((eveArchived.data as { by: string }).by).toBe(alice.agentId);

      const listDefault = (yield* bob.client.sendRpc(
        "conversations/list",
        {},
      )) as { conversations: Array<{ id: string }> };
      expect(
        listDefault.conversations.find((c) => c.id === conversationId),
      ).toBeUndefined();

      const listInclude = (yield* bob.client.sendRpc("conversations/list", {
        archived: "include",
      })) as { conversations: Array<{ id: string }> };
      expect(
        listInclude.conversations.find((c) => c.id === conversationId),
      ).toBeDefined();

      const listOnly = (yield* bob.client.sendRpc("conversations/list", {
        archived: "only",
      })) as { conversations: Array<{ id: string }> };
      expect(listOnly.conversations.length).toBe(1);
      expect(listOnly.conversations[0]!.id).toBe(conversationId);

      yield* alice.client.sendRpc("conversations/unarchive", {
        conversationId,
      });
      const bobUnarchived = yield* bob.client.waitForEvent(
        "conversations/unarchived",
      );
      expect(
        (bobUnarchived.data as { conversationId: string }).conversationId,
      ).toBe(conversationId);

      const listAfter = (yield* bob.client.sendRpc(
        "conversations/list",
        {},
      )) as { conversations: Array<{ id: string }> };
      expect(
        listAfter.conversations.find((c) => c.id === conversationId),
      ).toBeDefined();
    }),
  );

  it.live("non-owner/admin member gets 403 on archive", () =>
    Effect.gen(function* () {
      const group = yield* setupAgentGroup(2, { groupName: "Perm Test" });
      const [, bob] = group.agents as [ConnectedAgent, ConnectedAgent];
      const conversationId = group.conversationId!;

      yield* expectRpcFailure(
        bob.client.sendRpc("conversations/archive", { conversationId }),
        ErrorCodes.Forbidden,
      );
    }),
  );

  it.live("admin can archive (role promoted directly)", () =>
    Effect.gen(function* () {
      const group = yield* setupAgentGroup(2, { groupName: "Admin Test" });
      const [, bob] = group.agents as [ConnectedAgent, ConnectedAgent];
      const conversationId = group.conversationId!;

      // Role assignment goes through a separate admin API not wired here;
      // direct DB write is the minimal stand-in for the test.
      const db = getCoreDb();
      yield* Effect.promise(() =>
        db
          .updateTable("conversation_participants")
          .set({ role: "admin" })
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", bob.agentId)
          .execute(),
      );

      yield* bob.client.sendRpc("conversations/archive", { conversationId });
    }),
  );

  it.live("archive of archived conversation is idempotent", () =>
    Effect.gen(function* () {
      const group = yield* setupAgentGroup(2, { groupName: "Idempotent" });
      const [alice] = group.agents as [ConnectedAgent, ConnectedAgent];
      const conversationId = group.conversationId!;

      yield* alice.client.sendRpc("conversations/archive", { conversationId });
      yield* alice.client.sendRpc("conversations/archive", { conversationId });
    }),
  );

  it.live("unarchive of active conversation is idempotent", () =>
    Effect.gen(function* () {
      const group = yield* setupAgentGroup(2, { groupName: "Unarchive Idem" });
      const [alice] = group.agents as [ConnectedAgent, ConnectedAgent];
      const conversationId = group.conversationId!;

      yield* alice.client.sendRpc("conversations/unarchive", {
        conversationId,
      });
    }),
  );

  it.live("archive of session-attached conversation returns 409", () =>
    Effect.gen(function* () {
      const appId = "archive-test-app";
      coreApp.registerApp({
        appId,
        name: "Archive Test App",
        permissions: { required: [], optional: [] },
        conversations: [
          { key: "main", name: "Main", participantFilter: "all" },
        ],
        hooks: {
          before_message_delivery: { timeout_ms: 5000 },
          on_join: {},
          on_close: { timeout_ms: 5000 },
        },
      });

      const alice = yield* registerAndConnect("archive-alice");
      // owner_user_id is required for app session admission.
      const db = getCoreDb();
      yield* Effect.promise(() =>
        db
          .updateTable("agents")
          .set({ owner_user_id: crypto.randomUUID() })
          .where("id", "=", alice.agentId)
          .execute(),
      );

      const session = (yield* alice.client.sendRpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };
      const convId = session.session.conversations["main"]!;

      const err = yield* expectRpcFailure(
        alice.client.sendRpc("conversations/archive", {
          conversationId: convId,
        }),
        ErrorCodes.Conflict,
      );
      expect(err.message).toContain("active app session");
    }),
  );

  it.live("concurrent archive by two privileged callers — both succeed", () =>
    Effect.gen(function* () {
      const group = yield* setupAgentGroup(2, { groupName: "Race" });
      const [alice, bob] = group.agents as [ConnectedAgent, ConnectedAgent];
      const conversationId = group.conversationId!;

      const db = getCoreDb();
      yield* Effect.promise(() =>
        db
          .updateTable("conversation_participants")
          .set({ role: "admin" })
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", bob.agentId)
          .execute(),
      );

      const [r1, r2] = yield* Effect.all(
        [
          alice.client.sendRpc("conversations/archive", { conversationId }),
          bob.client.sendRpc("conversations/archive", { conversationId }),
        ],
        { concurrency: "unbounded" },
      );

      expect(r1).toEqual({});
      expect(r2).toEqual({});

      const row = yield* Effect.promise(() =>
        db
          .selectFrom("conversations")
          .select("archived_at")
          .where("id", "=", conversationId)
          .executeTakeFirst(),
      );
      expect(row?.archived_at).not.toBeNull();
    }),
  );
});
