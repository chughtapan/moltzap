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
  opts?: { hookTimeoutMs?: number; onCloseTimeoutMs?: number },
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
      on_close: {
        timeout_ms: opts?.onCloseTimeoutMs ?? 5000,
      },
    },
  });
}

describe("Scenario 31: Session Close + Conversation Archival", () => {
  describe("hookTimeout observability", () => {
    it("emits app/hookTimeout on before_message_delivery timeout", async () => {
      const agent = await registerAppAgent("bmd-timeout");

      registerTestApp(coreApp, "bmd-timeout-app", { hookTimeoutMs: 200 });

      coreApp.onBeforeMessageDelivery("bmd-timeout-app", async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return { block: true, reason: "never" };
      });

      const session = (await agent.client.rpc("apps/create", {
        appId: "bmd-timeout-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      const convId = session.session.conversations["main"]!;

      const timeoutPromise = agent.client.waitForEvent("app/hookTimeout", 3000);

      await agent.client.rpc("messages/send", {
        conversationId: convId,
        parts: [{ type: "text", text: "trigger timeout" }],
      });

      const timeoutEvent = await timeoutPromise;
      const data = timeoutEvent.data as {
        sessionId: string;
        appId: string;
        hookName: string;
        timeoutMs: number;
      };
      expect(data.sessionId).toBe(session.session.id);
      expect(data.appId).toBe("bmd-timeout-app");
      expect(data.hookName).toBe("before_message_delivery");
      expect(data.timeoutMs).toBe(200);
    });

    it("emits app/hookTimeout on on_close timeout", async () => {
      const agent = await registerAppAgent("close-timeout");

      registerTestApp(coreApp, "close-timeout-app", {
        onCloseTimeoutMs: 200,
      });

      coreApp.onSessionClose("close-timeout-app", async () => {
        await new Promise((r) => setTimeout(r, 1000));
      });

      const session = (await agent.client.rpc("apps/create", {
        appId: "close-timeout-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      const timeoutPromise = agent.client.waitForEvent("app/hookTimeout", 3000);

      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      const timeoutEvent = await timeoutPromise;
      const data = timeoutEvent.data as {
        sessionId: string;
        appId: string;
        hookName: string;
        timeoutMs: number;
      };
      expect(data.sessionId).toBe(session.session.id);
      expect(data.appId).toBe("close-timeout-app");
      expect(data.hookName).toBe("on_close");
      expect(data.timeoutMs).toBe(200);
    });
  });

  describe("closeSession", () => {
    it("closes session, archives conversations, sets closed_at", async () => {
      const agent = await registerAppAgent("close-basic");

      registerTestApp(coreApp, "close-basic-app");

      const session = (await agent.client.rpc("apps/create", {
        appId: "close-basic-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      const result = (await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      })) as { closed: boolean };

      expect(result.closed).toBe(true);

      // Verify DB state
      const db = getKyselyDb();
      const sessionRow = await db
        .selectFrom("app_sessions")
        .selectAll()
        .where("id", "=", session.session.id)
        .executeTakeFirstOrThrow();

      expect(sessionRow.status).toBe("closed");
      expect(sessionRow.closed_at).not.toBeNull();

      const convId = session.session.conversations["main"]!;
      const convRow = await db
        .selectFrom("conversations")
        .selectAll()
        .where("id", "=", convId)
        .executeTakeFirstOrThrow();

      expect(convRow.archived_at).not.toBeNull();
    });

    it("fires on_close hook with correct context", async () => {
      const agent = await registerAppAgent("close-hook");

      registerTestApp(coreApp, "close-hook-app");

      let hookCtx: {
        sessionId: string;
        appId: string;
        conversations: Record<string, string>;
        closedBy: { agentId: string };
      } | null = null;

      coreApp.onSessionClose("close-hook-app", (ctx) => {
        hookCtx = ctx;
      });

      const session = (await agent.client.rpc("apps/create", {
        appId: "close-hook-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      expect(hookCtx).not.toBeNull();
      expect(hookCtx!.sessionId).toBe(session.session.id);
      expect(hookCtx!.appId).toBe("close-hook-app");
      expect(hookCtx!.closedBy.agentId).toBe(agent.agentId);
      expect(hookCtx!.conversations).toHaveProperty("main");
    });

    it("rejects double close with SessionClosed error", async () => {
      const agent = await registerAppAgent("double-close");

      registerTestApp(coreApp, "double-close-app");

      const session = (await agent.client.rpc("apps/create", {
        appId: "double-close-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

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

    it("rejects close by non-initiator with Forbidden error", async () => {
      const initiator = await registerAppAgent("close-init");
      const stranger = await registerAppAgent("close-stranger");

      registerTestApp(coreApp, "close-forbidden-app");

      const session = (await initiator.client.rpc("apps/create", {
        appId: "close-forbidden-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      try {
        await stranger.client.rpc("apps/closeSession", {
          sessionId: session.session.id,
        });
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        const rpcErr = err as { code: number; message: string };
        expect(rpcErr.code).toBe(ErrorCodes.Forbidden);
      }
    });

    it("rejects close of nonexistent session with SessionNotFound", async () => {
      const agent = await registerAppAgent("close-notfound");

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

    it("broadcasts app/sessionClosed to initiator and admitted participants", async () => {
      const initiator = await registerAppAgent("close-broadcast-init");
      const invitee = await registerAppAgent("close-broadcast-inv");

      registerTestApp(coreApp, "close-broadcast-app");

      coreApp.onAppJoin("close-broadcast-app", () => {});

      const admittedPromise = invitee.client.waitForEvent(
        "app/participantAdmitted",
        5000,
      );

      const session = (await initiator.client.rpc("apps/create", {
        appId: "close-broadcast-app",
        invitedAgentIds: [invitee.agentId],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      await admittedPromise;

      const initClosedPromise = initiator.client.waitForEvent(
        "app/sessionClosed",
        3000,
      );
      const invClosedPromise = invitee.client.waitForEvent(
        "app/sessionClosed",
        3000,
      );

      await initiator.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      const initEvent = await initClosedPromise;
      const invEvent = await invClosedPromise;

      const initData = initEvent.data as {
        sessionId: string;
        closedBy: string;
      };
      expect(initData.sessionId).toBe(session.session.id);
      expect(initData.closedBy).toBe(initiator.agentId);

      const invData = invEvent.data as {
        sessionId: string;
        closedBy: string;
      };
      expect(invData.sessionId).toBe(session.session.id);
    });

    it("rejects messages to archived conversations", async () => {
      const agent = await registerAppAgent("archived-msg");

      registerTestApp(coreApp, "archived-msg-app");

      const session = (await agent.client.rpc("apps/create", {
        appId: "archived-msg-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      const convId = session.session.conversations["main"]!;

      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      try {
        await agent.client.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "should fail" }],
        });
        expect.unreachable("Should have thrown");
      } catch (err: unknown) {
        const rpcErr = err as { code: number; message: string };
        expect(rpcErr.code).toBe(ErrorCodes.ConversationArchived);
      }
    });

    it("excludes archived conversations from conversations/list", async () => {
      const agent = await registerAppAgent("archived-list");

      registerTestApp(coreApp, "archived-list-app");

      const session = (await agent.client.rpc("apps/create", {
        appId: "archived-list-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      // Verify conversation appears before close
      const beforeList = (await agent.client.rpc("conversations/list", {})) as {
        conversations: Array<{ id: string }>;
      };
      const convId = session.session.conversations["main"]!;
      expect(beforeList.conversations.some((c) => c.id === convId)).toBe(true);

      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      const afterList = (await agent.client.rpc("conversations/list", {})) as {
        conversations: Array<{ id: string }>;
      };
      expect(afterList.conversations.some((c) => c.id === convId)).toBe(false);
    });

    it("on_close hook can send final messages before archive", async () => {
      const agent = await registerAppAgent("close-final-msg");

      registerTestApp(coreApp, "close-final-msg-app");

      let finalMessageSent = false;
      coreApp.onSessionClose("close-final-msg-app", async (ctx) => {
        const mainConvId = ctx.conversations["main"];
        if (mainConvId) {
          await agent.client.rpc("messages/send", {
            conversationId: mainConvId,
            parts: [{ type: "text", text: "Final message before close" }],
          });
          finalMessageSent = true;
        }
      });

      const session = (await agent.client.rpc("apps/create", {
        appId: "close-final-msg-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      expect(finalMessageSent).toBe(true);

      // Verify the final message was persisted
      const convId = session.session.conversations["main"]!;
      const db = getKyselyDb();
      const messages = await db
        .selectFrom("messages")
        .selectAll()
        .where("conversation_id", "=", convId)
        .execute();
      expect(messages.length).toBe(1);
    });
  });

  describe("getSession", () => {
    it("returns session with conversations for initiator", async () => {
      const agent = await registerAppAgent("get-init");

      registerTestApp(coreApp, "get-init-app");

      const created = (await agent.client.rpc("apps/create", {
        appId: "get-init-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      const result = (await agent.client.rpc("apps/getSession", {
        sessionId: created.session.id,
      })) as {
        session: {
          id: string;
          appId: string;
          status: string;
          conversations: Record<string, string>;
        };
      };

      expect(result.session.id).toBe(created.session.id);
      expect(result.session.appId).toBe("get-init-app");
      expect(result.session.status).toBe("active");
      expect(result.session.conversations).toHaveProperty("main");
    });

    it("returns session for admitted participant", async () => {
      const initiator = await registerAppAgent("get-part-init");
      const invitee = await registerAppAgent("get-part-inv");

      registerTestApp(coreApp, "get-part-app");
      coreApp.onAppJoin("get-part-app", () => {});

      const admittedPromise = invitee.client.waitForEvent(
        "app/participantAdmitted",
        5000,
      );

      const session = (await initiator.client.rpc("apps/create", {
        appId: "get-part-app",
        invitedAgentIds: [invitee.agentId],
      })) as {
        session: { id: string };
      };

      await admittedPromise;

      const result = (await invitee.client.rpc("apps/getSession", {
        sessionId: session.session.id,
      })) as {
        session: { id: string; appId: string };
      };

      expect(result.session.id).toBe(session.session.id);
      expect(result.session.appId).toBe("get-part-app");
    });

    it("rejects getSession for nonexistent session with SessionNotFound", async () => {
      const agent = await registerAppAgent("get-notfound");

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

    it("rejects getSession by stranger with Forbidden", async () => {
      const initiator = await registerAppAgent("get-stranger-init");
      const stranger = await registerAppAgent("get-stranger");

      registerTestApp(coreApp, "get-stranger-app");

      const session = (await initiator.client.rpc("apps/create", {
        appId: "get-stranger-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string };
      };

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
  });

  describe("listSessions", () => {
    it("returns only caller's sessions", async () => {
      const alice = await registerAppAgent("list-alice");
      const bob = await registerAppAgent("list-bob");

      registerTestApp(coreApp, "list-app");

      await alice.client.rpc("apps/create", {
        appId: "list-app",
        invitedAgentIds: [],
      });

      await bob.client.rpc("apps/create", {
        appId: "list-app",
        invitedAgentIds: [],
      });

      const aliceResult = (await alice.client.rpc("apps/listSessions", {})) as {
        sessions: Array<{ id: string; initiatorAgentId: string }>;
      };

      expect(aliceResult.sessions.length).toBe(1);
      expect(aliceResult.sessions[0]!.initiatorAgentId).toBe(alice.agentId);

      const bobResult = (await bob.client.rpc("apps/listSessions", {})) as {
        sessions: Array<{ id: string; initiatorAgentId: string }>;
      };

      expect(bobResult.sessions.length).toBe(1);
      expect(bobResult.sessions[0]!.initiatorAgentId).toBe(bob.agentId);
    });

    it("filters by appId and status", async () => {
      const agent = await registerAppAgent("list-filter");

      registerTestApp(coreApp, "list-filter-a");
      registerTestApp(coreApp, "list-filter-b");

      const sessionA = (await agent.client.rpc("apps/create", {
        appId: "list-filter-a",
        invitedAgentIds: [],
      })) as { session: { id: string } };

      await agent.client.rpc("apps/create", {
        appId: "list-filter-b",
        invitedAgentIds: [],
      });

      // Close session A
      await agent.client.rpc("apps/closeSession", {
        sessionId: sessionA.session.id,
      });

      // Filter by appId
      const byApp = (await agent.client.rpc("apps/listSessions", {
        appId: "list-filter-a",
      })) as { sessions: Array<{ appId: string }> };
      expect(byApp.sessions.length).toBe(1);
      expect(byApp.sessions[0]!.appId).toBe("list-filter-a");

      // Filter by status
      const active = (await agent.client.rpc("apps/listSessions", {
        status: "active",
      })) as { sessions: Array<{ status: string }> };
      expect(active.sessions.length).toBe(1);
      expect(active.sessions[0]!.status).toBe("active");

      const closed = (await agent.client.rpc("apps/listSessions", {
        status: "closed",
      })) as { sessions: Array<{ status: string }> };
      expect(closed.sessions.length).toBe(1);
      expect(closed.sessions[0]!.status).toBe("closed");
    });

    it("applies limit default of 50", async () => {
      const agent = await registerAppAgent("list-limit");

      registerTestApp(coreApp, "list-limit-app");

      // Create 3 sessions, request limit of 2
      for (let i = 0; i < 3; i++) {
        await agent.client.rpc("apps/create", {
          appId: "list-limit-app",
          invitedAgentIds: [],
        });
      }

      const limited = (await agent.client.rpc("apps/listSessions", {
        limit: 2,
      })) as { sessions: Array<{ id: string }> };
      expect(limited.sessions.length).toBe(2);

      // Default (no limit param) returns all 3
      const all = (await agent.client.rpc("apps/listSessions", {})) as {
        sessions: Array<{ id: string }>;
      };
      expect(all.sessions.length).toBe(3);
    });
  });

  describe("getSession after close", () => {
    it("returns closed session with closedAt", async () => {
      const agent = await registerAppAgent("get-closed");

      registerTestApp(coreApp, "get-closed-app");

      const session = (await agent.client.rpc("apps/create", {
        appId: "get-closed-app",
        invitedAgentIds: [],
      })) as {
        session: { id: string };
      };

      await agent.client.rpc("apps/closeSession", {
        sessionId: session.session.id,
      });

      const result = (await agent.client.rpc("apps/getSession", {
        sessionId: session.session.id,
      })) as {
        session: {
          id: string;
          status: string;
          closedAt?: string;
        };
      };

      expect(result.session.status).toBe("closed");
      expect(result.session.closedAt).toBeDefined();
    });
  });
});
