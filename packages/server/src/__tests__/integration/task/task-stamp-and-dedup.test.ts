/**
 * Phase 9b follow-ups #464 (no orphan task on DM dedup) +
 * #465 (`messages.task_id` stamped at INSERT time).
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "../helpers.js";

import { ConversationsCreate, MessagesSend } from "@moltzap/protocol";

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Phase 9b follow-ups: dedup-aware DM + task_id stamp", () => {
  it.live(
    "#464: messages/send agent:<name> twice produces ONE task, not two",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnect("alice-464a");
        const bob = yield* registerAndConnect("bob-464a");

        const first = (yield* alice.client.sendRpc(MessagesSend, {
          to: `agent:${bob.name}`,
          parts: [{ type: "text", text: "first" }],
        })) as { message: { conversationId: string } };

        yield* alice.client.sendRpc(MessagesSend, {
          to: `agent:${bob.name}`,
          parts: [{ type: "text", text: "second" }],
        });

        const db = getKyselyDb();
        const conv = yield* Effect.tryPromise(() =>
          db
            .selectFrom("conversations")
            .select(["task_id"])
            .where("id", "=", first.message.conversationId)
            .executeTakeFirstOrThrow(),
        );
        const tasksForAlice = yield* Effect.tryPromise(() =>
          db
            .selectFrom("tasks")
            .select(["id"])
            .where("initiator_agent_id", "=", alice.agentId)
            .execute(),
        );
        expect(tasksForAlice).toHaveLength(1);
        expect(tasksForAlice[0]!.id).toBe(conv.task_id);
      }),
  );

  it.live(
    "#464: conversations/create { type: dm } twice produces ONE task, not two",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnect("alice-464b");
        const bob = yield* registerAndConnect("bob-464b");

        const first = (yield* alice.client.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        })) as { conversation: { id: string } };

        const second = (yield* alice.client.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        })) as { conversation: { id: string } };

        expect(second.conversation.id).toBe(first.conversation.id);

        const db = getKyselyDb();
        const tasksForAlice = yield* Effect.tryPromise(() =>
          db
            .selectFrom("tasks")
            .select(["id"])
            .where("initiator_agent_id", "=", alice.agentId)
            .execute(),
        );
        expect(tasksForAlice).toHaveLength(1);
      }),
  );

  it.live(
    "#465: messages/send stamps task_id matching conversations.task_id",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnect("alice-465");
        const bob = yield* registerAndConnect("bob-465");

        const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        })) as { conversation: { id: string } };

        const sendResult = (yield* alice.client.sendRpc(MessagesSend, {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "hello" }],
        })) as { message: { id: string } };

        const db = getKyselyDb();
        const messageRow = yield* Effect.tryPromise(() =>
          db
            .selectFrom("messages")
            .select(["task_id"])
            .where("id", "=", sendResult.message.id)
            .executeTakeFirstOrThrow(),
        );
        const convRow = yield* Effect.tryPromise(() =>
          db
            .selectFrom("conversations")
            .select(["task_id"])
            .where("id", "=", conv.conversation.id)
            .executeTakeFirstOrThrow(),
        );

        expect(messageRow.task_id).not.toBeNull();
        expect(messageRow.task_id).toBe(convRow.task_id);
      }),
  );
});
