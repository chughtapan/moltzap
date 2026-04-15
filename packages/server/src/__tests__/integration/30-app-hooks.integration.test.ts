import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";
import type { CoreApp } from "../../app/types.js";
import { ErrorCodes } from "@moltzap/protocol";
import type { ConnectedAgent } from "../../test-utils/helpers.js";

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

/** Register, connect, and assign an owner_user_id (required for app sessions). */
async function registerAppAgent(name: string): Promise<ConnectedAgent> {
  const agent = await registerAndConnect(name);
  const db = getKyselyDb();
  await db
    .updateTable("agents")
    .set({ owner_user_id: crypto.randomUUID() })
    .where("id", "=", agent.agentId)
    .execute();
  return agent;
}

function registerTestApp(
  app: CoreApp,
  appId: string,
  opts?: { hookTimeoutMs?: number },
) {
  app.registerApp({
    appId,
    name: `Test App ${appId}`,
    permissions: { required: [], optional: [] },
    conversations: [
      { key: "main", name: "Main Channel", participantFilter: "all" },
    ],
    hooks: {
      before_message_delivery: {
        timeout_ms: opts?.hookTimeoutMs ?? 5000,
      },
      on_join: {},
    },
  });
}

describe("Scenario 30: App Hooks", () => {
  describe("before_message_delivery", () => {
    it("blocks a message and returns structured feedback", async () => {
      const orchestrator = await registerAppAgent("orchestrator");

      registerTestApp(coreApp, "test-blocker");

      coreApp.onBeforeMessageDelivery("test-blocker", (ctx) => ({
        block: true,
        reason: "Invalid command format",
        feedback: {
          type: "error",
          content: {
            expected: "/kill target:AgentName",
            got: ctx.message.parts,
          },
          retry: true,
        },
      }));

      const session = (await orchestrator.client.rpc("apps/create", {
        appId: "test-blocker",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      const convId = session.session.conversations["main"]!;

      try {
        await orchestrator.client.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "bad command" }],
        });
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        const rpcErr = err as {
          code: number;
          message: string;
          data?: unknown;
        };
        expect(rpcErr.code).toBe(ErrorCodes.HookBlocked);
        expect(rpcErr.message).toContain("Invalid command format");
        expect(rpcErr.data).toHaveProperty("feedback");
        const feedback = (
          rpcErr.data as {
            feedback: { type: string; retry: boolean };
          }
        ).feedback;
        expect(feedback.type).toBe("error");
        expect(feedback.retry).toBe(true);
      }
    });

    it("patches message parts before delivery", async () => {
      const alice = await registerAppAgent("alice-hook");

      registerTestApp(coreApp, "test-patcher");

      coreApp.onBeforeMessageDelivery("test-patcher", (ctx) => ({
        block: false,
        patch: {
          parts: [
            {
              type: "text" as const,
              text:
                "[REDACTED] " + (ctx.message.parts[0] as { text: string }).text,
            },
          ],
        },
      }));

      const session = (await alice.client.rpc("apps/create", {
        appId: "test-patcher",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      const convId = session.session.conversations["main"]!;

      const result = (await alice.client.rpc("messages/send", {
        conversationId: convId,
        parts: [{ type: "text", text: "secret info" }],
      })) as {
        message: {
          parts: Array<{ type: string; text: string }>;
          patchedBy?: string;
        };
      };

      expect(result.message.parts[0]!.text).toBe("[REDACTED] secret info");
      expect(result.message.patchedBy).toBe("test-patcher");
    });

    it("passes through when hook allows", async () => {
      const agent = await registerAppAgent("passthrough-agent");

      registerTestApp(coreApp, "test-passthrough");

      coreApp.onBeforeMessageDelivery("test-passthrough", () => ({
        block: false,
      }));

      const session = (await agent.client.rpc("apps/create", {
        appId: "test-passthrough",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      const convId = session.session.conversations["main"]!;

      const result = (await agent.client.rpc("messages/send", {
        conversationId: convId,
        parts: [{ type: "text", text: "hello" }],
      })) as {
        message: { parts: Array<{ type: string; text: string }> };
      };

      expect(result.message.parts[0]!.text).toBe("hello");
    });

    it("times out, passes through, and emits hookTimeout event", async () => {
      const agent = await registerAppAgent("timeout-agent");

      registerTestApp(coreApp, "test-timeout", { hookTimeoutMs: 200 });

      coreApp.onBeforeMessageDelivery("test-timeout", async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return { block: true, reason: "Should never reach" };
      });

      const session = (await agent.client.rpc("apps/create", {
        appId: "test-timeout",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      const convId = session.session.conversations["main"]!;

      const timeoutPromise = agent.client.waitForEvent("app/hookTimeout", 3000);

      const result = (await agent.client.rpc("messages/send", {
        conversationId: convId,
        parts: [{ type: "text", text: "should pass" }],
      })) as {
        message: { parts: Array<{ type: string; text: string }> };
      };

      expect(result.message.parts[0]!.text).toBe("should pass");

      const timeoutEvent = await timeoutPromise;
      const data = timeoutEvent.data as {
        sessionId: string;
        appId: string;
        hookName: string;
        timeoutMs: number;
      };
      expect(data.hookName).toBe("before_message_delivery");
      expect(data.timeoutMs).toBe(200);
    });

    it("passes through for non-app conversations", async () => {
      const alice = await registerAppAgent("alice-noapp");
      const bob = await registerAppAgent("bob-noapp");

      const conv = (await alice.client.rpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };

      const result = (await alice.client.rpc("messages/send", {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "normal DM" }],
      })) as {
        message: { parts: Array<{ type: string; text: string }> };
      };

      expect(result.message.parts[0]!.text).toBe("normal DM");
    });

    it("fails open when hook throws", async () => {
      const agent = await registerAppAgent("error-agent");

      registerTestApp(coreApp, "test-error");

      coreApp.onBeforeMessageDelivery("test-error", () => {
        throw new Error("Hook crashed!");
      });

      const session = (await agent.client.rpc("apps/create", {
        appId: "test-error",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      const convId = session.session.conversations["main"]!;

      const result = (await agent.client.rpc("messages/send", {
        conversationId: convId,
        parts: [{ type: "text", text: "should still send" }],
      })) as {
        message: { parts: Array<{ type: string; text: string }> };
      };

      expect(result.message.parts[0]!.text).toBe("should still send");
    });
  });

  describe("on_join", () => {
    it("fires on_join when agent is admitted to session", async () => {
      const initiator = await registerAppAgent("init-join");
      const invitee = await registerAppAgent("invitee-join");

      let joinFired = false;
      let joinCtx: {
        agent: { agentId: string };
        conversations: Record<string, string>;
      } | null = null;

      registerTestApp(coreApp, "test-join");

      coreApp.onAppJoin("test-join", (ctx) => {
        joinFired = true;
        joinCtx = ctx;
      });

      await initiator.client.rpc("apps/create", {
        appId: "test-join",
        invitedAgentIds: [invitee.agentId],
      });

      // Wait for async admission to complete
      await new Promise((r) => setTimeout(r, 500));

      expect(joinFired).toBe(true);
      expect(joinCtx!.agent.agentId).toBe(invitee.agentId);
      expect(joinCtx!.conversations).toHaveProperty("main");
    });
  });
});
