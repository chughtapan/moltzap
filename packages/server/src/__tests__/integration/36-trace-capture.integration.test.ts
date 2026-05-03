import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";

import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
  type ConnectedAgent,
} from "./helpers.js";
import {
  InMemoryTraceCaptureLive,
  type TraceCapture,
} from "../../runtime-surface/trace-capture.js";
import type { CoreApp } from "../../app/types.js";
import { ErrorCodes } from "@moltzap/protocol";
import { expectRpcFailure } from "../../test-utils/index.js";

import {
  AppsCreate,
  ConversationsCreate,
  MessagesSend,
} from "@moltzap/protocol";

let traceCapture: TraceCapture;
let coreApp: CoreApp;

beforeAll(async () => {
  const server = await startTestServer({
    traceCaptureLayer: InMemoryTraceCaptureLive,
  });
  traceCapture = server.coreApp.traceCapture;
  coreApp = server.coreApp;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  await Effect.runPromise(traceCapture.clear());
});

function registerAppAgent(name: string): Effect.Effect<ConnectedAgent, Error> {
  return Effect.gen(function* () {
    const agent = yield* registerAndConnect(name);
    const db = getKyselyDb();
    yield* Effect.tryPromise(() =>
      db
        .updateTable("agents")
        .set({ owner_user_id: crypto.randomUUID() })
        .where("id", "=", agent.agentId)
        .execute(),
    );
    return agent;
  });
}

function registerTestApp(appId: string): void {
  coreApp.registerApp({
    appId,
    name: `Trace Test App ${appId}`,
    permissions: { required: [], optional: [] },
    conversations: [
      { key: "main", name: "Main Channel", participantFilter: "all" },
    ],
    hooks: {
      before_message_delivery: { timeout_ms: 5000 },
    },
  });
}

describe("trace capture", () => {
  it.live("records delivered messages through the server DI capture", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-trace-capture");
      const bob = yield* registerAndConnect("bob-trace-capture");

      const conv = (yield* alice.client.sendRpc(ConversationsCreate.name, {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };

      yield* alice.client.sendRpc(MessagesSend.name, {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "hello from trace capture test" }],
      });
      yield* bob.client.waitForEvent("messages/received");

      const events = yield* traceCapture.snapshot();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        _tag: "Message",
        channelKey: conv.conversation.id,
        senderDisplayName: alice.name,
        recipientAgentIds: [bob.agentId],
        deliveredAgentIds: [bob.agentId],
        message: {
          conversationId: conv.conversation.id,
          senderId: alice.agentId,
          parts: [{ type: "text", text: "hello from trace capture test" }],
        },
      });

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );

  it.live("records blocked before_message_delivery hooks", () =>
    Effect.gen(function* () {
      const appId = "trace-hook-blocker";
      const orchestrator = yield* registerAppAgent("trace-hook-orchestrator");

      registerTestApp(appId);
      coreApp.onBeforeMessageDelivery(appId, () => ({
        block: true,
        reason: "trace_blocked_command",
      }));

      const session = (yield* orchestrator.client.sendRpc(AppsCreate.name, {
        appId,
        invitedAgentIds: [],
      })) as {
        session: { conversations: Record<string, string> };
      };
      const conversationId = session.session.conversations["main"]!;

      yield* expectRpcFailure(
        orchestrator.client.sendRpc(MessagesSend.name, {
          conversationId,
          parts: [{ type: "text", text: "bad command for trace" }],
        }),
        ErrorCodes.HookBlocked,
      );

      const events = yield* traceCapture.snapshot();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        _tag: "HookBlocked",
        hookName: "before_message_delivery",
        conversationId,
        channelKey: "main",
        senderAgentId: orchestrator.agentId,
        senderDisplayName: orchestrator.name,
        reason: "trace_blocked_command",
        parts: [{ type: "text", text: "bad command for trace" }],
      });

      yield* orchestrator.client.close();
    }),
  );
});
