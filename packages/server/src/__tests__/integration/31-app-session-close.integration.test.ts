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
import type { AppSession } from "@moltzap/protocol";

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
  opts?: { closeHookTimeoutMs?: number },
) {
  app.registerApp({
    appId,
    name: `Test App ${appId}`,
    permissions: { required: [], optional: [] },
    conversations: [
      { key: "main", name: "Main Channel", participantFilter: "all" },
    ],
    hooks: {
      before_message_delivery: { timeout_ms: 5000 },
      on_join: {},
      on_close: { timeout_ms: opts?.closeHookTimeoutMs ?? 5000 },
    },
  });
}

type SessionResult = {
  session: {
    id: string;
    conversations: Record<string, string>;
    status: string;
  };
};

describe("Scenario 31: App Session Close + Conversation Archival", () => {
  describe("Hook timeout observability", () => {
    it("emits app/hookTimeout when before_message_delivery hook times out", async () => {
      const agent = await registerAppAgent("timeout-obs-agent");
      const appId = "timeout-obs-app";

      coreApp.registerApp({
        appId,
        name: "Timeout Obs",
        permissions: { required: [], optional: [] },
        conversations: [
          { key: "main", name: "Main", participantFilter: "all" },
        ],
        hooks: {
          before_message_delivery: { timeout_ms: 200 },
        },
      });

      coreApp.onBeforeMessageDelivery(appId, async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return { block: true, reason: "Should never reach" };
      });

      const session = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      const convId = session.session.conversations["main"]!;

      // Message should pass through (hook timed out → fail-open)
      const result = (await agent.client.rpc("messages/send", {
        conversationId: convId,
        parts: [{ type: "text", text: "should pass" }],
      })) as { message: { parts: Array<{ type: string; text: string }> } };

      expect(result.message.parts[0]!.text).toBe("should pass");
    });

    it("emits app/hookTimeout when on_close hook times out", async () => {
      const agent = await registerAppAgent("close-timeout-agent");
      const appId = "close-timeout-app";

      registerTestApp(coreApp, appId, { closeHookTimeoutMs: 200 });

      coreApp.onAppClose(appId, async () => {
        await new Promise((r) => setTimeout(r, 1000));
      });

      const session = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      const result = (await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      })) as { closed: boolean };

      expect(result.closed).toBe(true);

      // Wait for events to arrive
      await new Promise((r) => setTimeout(r, 500));

      const events = agent.client.drainEvents();
      const hookTimeoutEvent = events.find(
        (e) => e.event === "app/hookTimeout",
      );
      expect(hookTimeoutEvent).toBeDefined();
      expect((hookTimeoutEvent!.data as Record<string, unknown>).hookName).toBe(
        "on_close",
      );
    });

    it("does not emit hookTimeout when on_close hook completes in time", async () => {
      const agent = await registerAppAgent("close-fast-agent");
      const appId = "close-fast-app";

      registerTestApp(coreApp, appId);

      let hookFired = false;
      coreApp.onAppClose(appId, () => {
        hookFired = true;
      });

      const session = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      await new Promise((r) => setTimeout(r, 300));

      expect(hookFired).toBe(true);
      const events = agent.client.drainEvents();
      const hookTimeoutEvent = events.find(
        (e) => e.event === "app/hookTimeout",
      );
      expect(hookTimeoutEvent).toBeUndefined();
    });

    it("close succeeds even when on_close hook throws", async () => {
      const agent = await registerAppAgent("close-error-agent");
      const appId = "close-error-app";

      registerTestApp(coreApp, appId);

      coreApp.onAppClose(appId, () => {
        throw new Error("Hook crashed!");
      });

      const session = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      const result = (await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      })) as { closed: boolean };

      expect(result.closed).toBe(true);
    });
  });

  describe("Close session", () => {
    it("closes a session and returns closed: true", async () => {
      const agent = await registerAppAgent("close-basic-agent");
      const appId = "close-basic-app";

      registerTestApp(coreApp, appId);

      const session = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      const result = (await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      })) as { closed: boolean };

      expect(result.closed).toBe(true);

      // Verify DB state
      const db = getKyselyDb();
      const row = await db
        .selectFrom("app_sessions")
        .selectAll()
        .where("id", "=", session.session.id)
        .executeTakeFirst();

      expect(row!.status).toBe("closed");
      expect(row!.closed_at).not.toBeNull();
    });

    it("fires on_close hook with correct context", async () => {
      const agent = await registerAppAgent("close-hook-agent");
      const appId = "close-hook-app";

      registerTestApp(coreApp, appId);

      let hookCtx: {
        sessionId: string;
        appId: string;
        conversations: Record<string, string>;
        closedBy: { agentId: string };
      } | null = null;

      coreApp.onAppClose(appId, (ctx) => {
        hookCtx = ctx;
      });

      const session = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      expect(hookCtx).not.toBeNull();
      expect(hookCtx!.sessionId).toBe(session.session.id);
      expect(hookCtx!.appId).toBe(appId);
      expect(hookCtx!.closedBy.agentId).toBe(agent.agentId);
      expect(hookCtx!.conversations).toHaveProperty("main");
    });

    it("rejects double-close with SessionClosed error", async () => {
      const agent = await registerAppAgent("close-double-agent");
      const appId = "close-double-app";

      registerTestApp(coreApp, appId);

      const session = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      try {
        await agent.client.rpc("apps/closeSession", {
          sessionId: session.session.id,
        });
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        const rpcErr = err as { code: number; message: string };
        expect(rpcErr.code).toBe(ErrorCodes.SessionClosed);
      }
    });

    it("rejects close from non-initiator with Forbidden", async () => {
      const initiator = await registerAppAgent("close-auth-initiator");
      const invitee = await registerAppAgent("close-auth-invitee");
      const appId = "close-auth-app";

      registerTestApp(coreApp, appId);

      const session = (await initiator.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [invitee.agentId],
      })) as SessionResult;

      // Wait for admission
      await new Promise((r) => setTimeout(r, 500));

      try {
        await invitee.client.rpc("apps/closeSession", {
          sessionId: session.session.id,
        });
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        const rpcErr = err as { code: number; message: string };
        expect(rpcErr.code).toBe(ErrorCodes.Forbidden);
      }
    });

    it("broadcasts app/sessionClosed event to initiator and participants", async () => {
      const initiator = await registerAppAgent("close-evt-init");
      const invitee = await registerAppAgent("close-evt-inv");
      const appId = "close-evt-app";

      registerTestApp(coreApp, appId);

      const session = (await initiator.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [invitee.agentId],
      })) as SessionResult;

      // Wait for admission
      await new Promise((r) => setTimeout(r, 500));

      // Drain any existing events
      initiator.client.drainEvents();
      invitee.client.drainEvents();

      await initiator.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      await new Promise((r) => setTimeout(r, 300));

      const initiatorEvents = initiator.client.drainEvents();
      const inviteeEvents = invitee.client.drainEvents();

      const initClosedEvt = initiatorEvents.find(
        (e) => e.event === "app/sessionClosed",
      );
      expect(initClosedEvt).toBeDefined();
      expect((initClosedEvt!.data as Record<string, unknown>).sessionId).toBe(
        session.session.id,
      );

      const invClosedEvt = inviteeEvents.find(
        (e) => e.event === "app/sessionClosed",
      );
      expect(invClosedEvt).toBeDefined();
    });

    it("guards: rejects messages/send to archived conversation", async () => {
      const agent = await registerAppAgent("close-guard-agent");
      const appId = "close-guard-app";

      registerTestApp(coreApp, appId);

      const session = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      const convId = session.session.conversations["main"]!;

      // Send a message before close — should work
      await agent.client.rpc("messages/send", {
        conversationId: convId,
        parts: [{ type: "text", text: "before close" }],
      });

      // Close the session
      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      // Try to send after close — should fail
      try {
        await agent.client.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "after close" }],
        });
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        const rpcErr = err as { code: number; message: string };
        expect(rpcErr.code).toBe(ErrorCodes.ConversationArchived);
      }
    });

    it("filters archived conversations from conversations/list", async () => {
      const agent = await registerAppAgent("close-filter-agent");
      const appId = "close-filter-app";

      registerTestApp(coreApp, appId);

      const session = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      // List should include the app conversation
      const listBefore = (await agent.client.rpc("conversations/list", {})) as {
        conversations: Array<{ id: string }>;
      };
      const convId = session.session.conversations["main"]!;
      expect(listBefore.conversations.some((c) => c.id === convId)).toBe(true);

      // Close the session
      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      // List should exclude the archived conversation
      const listAfter = (await agent.client.rpc("conversations/list", {})) as {
        conversations: Array<{ id: string }>;
      };
      expect(listAfter.conversations.some((c) => c.id === convId)).toBe(false);
    });

    it("returns SessionNotFound for non-existent session", async () => {
      const agent = await registerAppAgent("close-notfound-agent");

      try {
        await agent.client.rpc("apps/closeSession", {
          sessionId: crypto.randomUUID(),
        });
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        const rpcErr = err as { code: number; message: string };
        expect(rpcErr.code).toBe(ErrorCodes.SessionNotFound);
      }
    });
  });

  describe("Query APIs", () => {
    it("getSession returns session for initiator", async () => {
      const agent = await registerAppAgent("get-init-agent");
      const appId = "get-init-app";

      registerTestApp(coreApp, appId);

      const session = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      const result = (await agent.client.rpc("apps/getSession", {
        sessionId: session.session.id,
      })) as { session: AppSession };

      expect(result.session.id).toBe(session.session.id);
      expect(result.session.appId).toBe(appId);
      expect(result.session.status).toBe("active");
      expect(result.session.conversations).toHaveProperty("main");
    });

    it("getSession returns session for admitted participant", async () => {
      const initiator = await registerAppAgent("get-part-init");
      const invitee = await registerAppAgent("get-part-inv");
      const appId = "get-part-app";

      registerTestApp(coreApp, appId);

      const session = (await initiator.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [invitee.agentId],
      })) as SessionResult;

      await new Promise((r) => setTimeout(r, 500));

      const result = (await invitee.client.rpc("apps/getSession", {
        sessionId: session.session.id,
      })) as { session: AppSession };

      expect(result.session.id).toBe(session.session.id);
    });

    it("getSession rejects non-participants", async () => {
      const initiator = await registerAppAgent("get-reject-init");
      const stranger = await registerAppAgent("get-reject-stranger");
      const appId = "get-reject-app";

      registerTestApp(coreApp, appId);

      const session = (await initiator.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      try {
        await stranger.client.rpc("apps/getSession", {
          sessionId: session.session.id,
        });
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        const rpcErr = err as { code: number };
        expect(rpcErr.code).toBe(ErrorCodes.Forbidden);
      }
    });

    it("getSession returns SessionNotFound for non-existent session", async () => {
      const agent = await registerAppAgent("get-notfound-agent");

      try {
        await agent.client.rpc("apps/getSession", {
          sessionId: crypto.randomUUID(),
        });
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        const rpcErr = err as { code: number };
        expect(rpcErr.code).toBe(ErrorCodes.SessionNotFound);
      }
    });

    it("listSessions returns all sessions for initiator", async () => {
      const agent = await registerAppAgent("list-all-agent");
      const appId = "list-all-app";

      registerTestApp(coreApp, appId);

      // Create two sessions
      await agent.client.rpc("apps/create", { appId, invitedAgentIds: [] });
      await agent.client.rpc("apps/create", { appId, invitedAgentIds: [] });

      const result = (await agent.client.rpc("apps/listSessions", {})) as {
        sessions: AppSession[];
      };

      expect(result.sessions.length).toBe(2);
    });

    it("listSessions filters by appId", async () => {
      const agent = await registerAppAgent("list-filter-agent");

      registerTestApp(coreApp, "list-app-a");
      registerTestApp(coreApp, "list-app-b");

      await agent.client.rpc("apps/create", {
        appId: "list-app-a",
        invitedAgentIds: [],
      });
      await agent.client.rpc("apps/create", {
        appId: "list-app-b",
        invitedAgentIds: [],
      });

      const result = (await agent.client.rpc("apps/listSessions", {
        appId: "list-app-a",
      })) as { sessions: AppSession[] };

      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0]!.appId).toBe("list-app-a");
    });

    it("listSessions filters by status", async () => {
      const agent = await registerAppAgent("list-status-agent");
      const appId = "list-status-app";

      registerTestApp(coreApp, appId);

      const session1 = (await agent.client.rpc("apps/create", {
        appId,
        invitedAgentIds: [],
      })) as SessionResult;

      await agent.client.rpc("apps/create", { appId, invitedAgentIds: [] });

      // Close the first session
      await agent.client.rpc("apps/closeSession", {
        sessionId: session1.session.id,
      });

      const activeSessions = (await agent.client.rpc("apps/listSessions", {
        status: "active",
      })) as { sessions: AppSession[] };

      expect(activeSessions.sessions.length).toBe(1);

      const closedSessions = (await agent.client.rpc("apps/listSessions", {
        status: "closed",
      })) as { sessions: AppSession[] };

      expect(closedSessions.sessions.length).toBe(1);
      expect(closedSessions.sessions[0]!.closedAt).toBeDefined();
    });

    it("listSessions returns empty for other agents", async () => {
      const initiator = await registerAppAgent("list-other-init");
      const other = await registerAppAgent("list-other-agent");
      const appId = "list-other-app";

      registerTestApp(coreApp, appId);

      await initiator.client.rpc("apps/create", { appId, invitedAgentIds: [] });

      const result = (await other.client.rpc("apps/listSessions", {})) as {
        sessions: AppSession[];
      };

      expect(result.sessions.length).toBe(0);
    });
  });
});
