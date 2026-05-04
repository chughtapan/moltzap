import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";
import type { CoreApp } from "../../app/types.js";
import {
  AppsAuthorizeDispatch,
  AppsCloseSession,
  AppsCreate,
  ErrorCodes,
  ConversationArchivedNotificationDefinition,
  AppParticipantAdmittedNotificationDefinition,
  AppSessionClosedNotificationDefinition,
  AppHookTimeoutNotificationDefinition,
} from "@moltzap/protocol";
import type { ConnectedAgent } from "../../test-utils/helpers.js";
import { expectRpcFailure } from "../../test-utils/index.js";

import {
  AppsGetSession,
  AppsListSessions,
  ConversationsList,
  MessagesSend,
} from "@moltzap/protocol";

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

function registerTestApp(
  app: CoreApp,
  appId: string,
  opts?: { hookTimeoutMs?: number; onCloseTimeoutMs?: number },
) {
  app.registerApp({
    appId,
    name: `Test App ${appId}`,
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
    it.live("emits app/hookTimeout on before_message_delivery timeout", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("bmd-timeout");

        registerTestApp(coreApp, "bmd-timeout-app", { hookTimeoutMs: 200 });

        coreApp.onBeforeMessageDelivery("bmd-timeout-app", async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return { block: true, reason: "never" };
        });

        const session = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "bmd-timeout-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        // Fail-closed: send rejects with HookBlocked. The app/hookTimeout
        // event asserted below is what distinguishes timeout from throw.
        yield* expectRpcFailure(
          agent.client.sendRpc(MessagesSend, {
            conversationId: convId,
            parts: [{ type: "text", text: "trigger timeout" }],
          }),
          ErrorCodes.HookBlocked,
        );

        const timeoutEvent = yield* agent.client.waitForNotification(
          AppHookTimeoutNotificationDefinition,
          3000,
        );
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
      }),
    );

    it.live("emits app/hookTimeout on on_close timeout", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("close-timeout");

        registerTestApp(coreApp, "close-timeout-app", {
          onCloseTimeoutMs: 200,
        });

        coreApp.onSessionClose("close-timeout-app", async () => {
          await new Promise((r) => setTimeout(r, 1000));
        });

        const session = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "close-timeout-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        yield* agent.client.sendRpc(AppsCloseSession, {
          sessionId: session.session.id,
        });

        const timeoutEvent = yield* agent.client.waitForNotification(
          AppHookTimeoutNotificationDefinition,
          3000,
        );
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
      }),
    );
  });

  describe("closeSession", () => {
    it.live("closes session, archives conversations, sets closed_at", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("close-basic");

        registerTestApp(coreApp, "close-basic-app");

        const session = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "close-basic-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const result = (yield* agent.client.sendRpc(AppsCloseSession, {
          sessionId: session.session.id,
        })) as { closed: boolean };

        expect(result.closed).toBe(true);

        // Verify DB state
        const db = getKyselyDb();
        const sessionRow = yield* Effect.tryPromise(() =>
          db
            .selectFrom("app_sessions")
            .selectAll()
            .where("id", "=", session.session.id)
            .executeTakeFirstOrThrow(),
        );

        expect(sessionRow.status).toBe("closed");
        expect(sessionRow.closed_at).not.toBeNull();

        const convId = session.session.conversations["main"]!;
        const convRow = yield* Effect.tryPromise(() =>
          db
            .selectFrom("conversations")
            .selectAll()
            .where("id", "=", convId)
            .executeTakeFirstOrThrow(),
        );

        expect(convRow.archived_at).not.toBeNull();
      }),
    );

    it.live("fires on_close hook with correct context", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("close-hook");

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

        const session = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "close-hook-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        yield* agent.client.sendRpc(AppsCloseSession, {
          sessionId: session.session.id,
        });

        expect(hookCtx).not.toBeNull();
        expect(hookCtx!.sessionId).toBe(session.session.id);
        expect(hookCtx!.appId).toBe("close-hook-app");
        expect(hookCtx!.closedBy.agentId).toBe(agent.agentId);
        expect(hookCtx!.conversations).toHaveProperty("main");
      }),
    );

    it.live("rejects double close with SessionClosed error", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("double-close");

        registerTestApp(coreApp, "double-close-app");

        const session = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "double-close-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        yield* agent.client.sendRpc(AppsCloseSession, {
          sessionId: session.session.id,
        });

        yield* expectRpcFailure(
          agent.client.sendRpc(AppsCloseSession, {
            sessionId: session.session.id,
          }),
          ErrorCodes.SessionClosed,
        );
      }),
    );

    it.live("rejects close by non-initiator with Forbidden error", () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("close-init");
        const stranger = yield* registerAppAgent("close-stranger");

        registerTestApp(coreApp, "close-forbidden-app");

        const session = (yield* initiator.client.sendRpc(AppsCreate, {
          appId: "close-forbidden-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        yield* expectRpcFailure(
          stranger.client.sendRpc(AppsCloseSession, {
            sessionId: session.session.id,
          }),
          ErrorCodes.Forbidden,
        );
      }),
    );

    it.live("rejects close of nonexistent session with SessionNotFound", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("close-notfound");

        yield* expectRpcFailure(
          agent.client.sendRpc(AppsCloseSession, {
            sessionId: crypto.randomUUID(),
          }),
          ErrorCodes.SessionNotFound,
        );
      }),
    );

    it.live(
      "broadcasts app/sessionClosed to initiator and admitted participants",
      () =>
        Effect.gen(function* () {
          const initiator = yield* registerAppAgent("close-broadcast-init");
          const invitee = yield* registerAppAgent("close-broadcast-inv");

          registerTestApp(coreApp, "close-broadcast-app");

          coreApp.onAppJoin("close-broadcast-app", () => {});

          const session = (yield* initiator.client.sendRpc(AppsCreate, {
            appId: "close-broadcast-app",
            invitedAgentIds: [invitee.agentId],
          })) as {
            session: { id: string; conversations: Record<string, string> };
          };

          yield* invitee.client.waitForNotification(
            AppParticipantAdmittedNotificationDefinition,
            5000,
          );

          yield* initiator.client.sendRpc(AppsCloseSession, {
            sessionId: session.session.id,
          });

          const initEvent = yield* initiator.client.waitForNotification(
            AppSessionClosedNotificationDefinition,
            3000,
          );
          const invEvent = yield* invitee.client.waitForNotification(
            AppSessionClosedNotificationDefinition,
            3000,
          );

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
        }),
    );

    it.live("broadcasts conversations/archived before app/sessionClosed", () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("close-archive-init");
        const invitee = yield* registerAppAgent("close-archive-inv");

        registerTestApp(coreApp, "close-archive-app");
        coreApp.onAppJoin("close-archive-app", () => {});

        const session = (yield* initiator.client.sendRpc(AppsCreate, {
          appId: "close-archive-app",
          invitedAgentIds: [invitee.agentId],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };
        const convId = session.session.conversations["main"]!;

        yield* invitee.client.waitForNotification(
          AppParticipantAdmittedNotificationDefinition,
          5000,
        );

        yield* initiator.client.sendRpc(AppsCloseSession, {
          sessionId: session.session.id,
        });

        const archived = yield* invitee.client.waitForNotification(
          ConversationArchivedNotificationDefinition,
          3000,
        );
        expect(
          (archived.data as { conversationId: string }).conversationId,
        ).toBe(convId);
        const closed = yield* invitee.client.waitForNotification(
          AppSessionClosedNotificationDefinition,
          3000,
        );
        expect((closed.data as { sessionId: string }).sessionId).toBe(
          session.session.id,
        );
      }),
    );

    it.live("rejects messages to archived conversations", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("archived-msg");

        registerTestApp(coreApp, "archived-msg-app");

        const session = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "archived-msg-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        yield* agent.client.sendRpc(AppsCloseSession, {
          sessionId: session.session.id,
        });

        yield* expectRpcFailure(
          agent.client.sendRpc(MessagesSend, {
            conversationId: convId,
            parts: [{ type: "text", text: "should fail" }],
          }),
          ErrorCodes.ConversationArchived,
        );
      }),
    );

    it.live(
      "denies dispatch authorization for archived app conversations",
      () =>
        Effect.gen(function* () {
          const agent = yield* registerAppAgent("archived-dispatch");

          registerTestApp(coreApp, "archived-dispatch-app");

          const session = (yield* agent.client.sendRpc(AppsCreate, {
            appId: "archived-dispatch-app",
            invitedAgentIds: [],
          })) as {
            session: { id: string; conversations: Record<string, string> };
          };
          const convId = session.session.conversations["main"]!;

          yield* agent.client.sendRpc(AppsCloseSession, {
            sessionId: session.session.id,
          });

          const result = yield* agent.client.sendRpc(AppsAuthorizeDispatch, {
            conversationId: convId,
            messageId: crypto.randomUUID(),
            senderAgentId: agent.agentId,
            attempt: 0,
            receivedAt: new Date().toISOString(),
            clock: {
              domainId: convId,
              epoch: 1,
              vector: { [agent.agentId]: 1 },
            },
            pending: [],
          });

          expect(result.admission).toEqual({
            decision: "deny",
            reason: "conversation_archived",
          });
        }),
    );

    it.live("excludes archived conversations from conversations/list", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("archived-list");

        registerTestApp(coreApp, "archived-list-app");

        const session = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "archived-list-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        // Verify conversation appears before close
        const beforeList = (yield* agent.client.sendRpc(
          ConversationsList,
          {},
        )) as {
          conversations: Array<{ id: string }>;
        };
        const convId = session.session.conversations["main"]!;
        expect(beforeList.conversations.some((c) => c.id === convId)).toBe(
          true,
        );

        yield* agent.client.sendRpc(AppsCloseSession, {
          sessionId: session.session.id,
        });

        const afterList = (yield* agent.client.sendRpc(
          ConversationsList,
          {},
        )) as {
          conversations: Array<{ id: string }>;
        };
        expect(afterList.conversations.some((c) => c.id === convId)).toBe(
          false,
        );
      }),
    );

    it.live("on_close hook can send final messages before archive", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("close-final-msg");

        registerTestApp(coreApp, "close-final-msg-app");

        let finalMessageSent = false;
        coreApp.onSessionClose("close-final-msg-app", async (ctx) => {
          const mainConvId = ctx.conversations["main"];
          if (mainConvId) {
            await Effect.runPromise(
              agent.client.sendRpc(MessagesSend, {
                conversationId: mainConvId,
                parts: [{ type: "text", text: "Final message before close" }],
              }),
            );
            finalMessageSent = true;
          }
        });

        const session = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "close-final-msg-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        yield* agent.client.sendRpc(AppsCloseSession, {
          sessionId: session.session.id,
        });

        expect(finalMessageSent).toBe(true);

        // Verify the final message was persisted
        const convId = session.session.conversations["main"]!;
        const db = getKyselyDb();
        const messages = yield* Effect.tryPromise(() =>
          db
            .selectFrom("messages")
            .selectAll()
            .where("conversation_id", "=", convId)
            .execute(),
        );
        expect(messages.length).toBe(1);
      }),
    );
  });

  describe("getSession", () => {
    it.live("returns session with conversations for initiator", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("get-init");

        registerTestApp(coreApp, "get-init-app");

        const created = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "get-init-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const result = (yield* agent.client.sendRpc(AppsGetSession, {
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
      }),
    );

    it.live("returns session for admitted participant", () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("get-part-init");
        const invitee = yield* registerAppAgent("get-part-inv");

        registerTestApp(coreApp, "get-part-app");
        coreApp.onAppJoin("get-part-app", () => {});

        const session = (yield* initiator.client.sendRpc(AppsCreate, {
          appId: "get-part-app",
          invitedAgentIds: [invitee.agentId],
        })) as {
          session: { id: string };
        };

        yield* invitee.client.waitForNotification(
          AppParticipantAdmittedNotificationDefinition,
          5000,
        );

        const result = (yield* invitee.client.sendRpc(AppsGetSession, {
          sessionId: session.session.id,
        })) as {
          session: { id: string; appId: string };
        };

        expect(result.session.id).toBe(session.session.id);
        expect(result.session.appId).toBe("get-part-app");
      }),
    );

    it.live(
      "rejects getSession for nonexistent session with SessionNotFound",
      () =>
        Effect.gen(function* () {
          const agent = yield* registerAppAgent("get-notfound");

          yield* expectRpcFailure(
            agent.client.sendRpc(AppsGetSession, {
              sessionId: crypto.randomUUID(),
            }),
            ErrorCodes.SessionNotFound,
          );
        }),
    );

    it.live("rejects getSession by stranger with Forbidden", () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("get-stranger-init");
        const stranger = yield* registerAppAgent("get-stranger");

        registerTestApp(coreApp, "get-stranger-app");

        const session = (yield* initiator.client.sendRpc(AppsCreate, {
          appId: "get-stranger-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string };
        };

        yield* expectRpcFailure(
          stranger.client.sendRpc(AppsGetSession, {
            sessionId: session.session.id,
          }),
          ErrorCodes.Forbidden,
        );
      }),
    );
  });

  describe("listSessions", () => {
    it.live("returns only caller's sessions", () =>
      Effect.gen(function* () {
        const alice = yield* registerAppAgent("list-alice");
        const bob = yield* registerAppAgent("list-bob");

        registerTestApp(coreApp, "list-app");

        yield* alice.client.sendRpc(AppsCreate, {
          appId: "list-app",
          invitedAgentIds: [],
        });

        yield* bob.client.sendRpc(AppsCreate, {
          appId: "list-app",
          invitedAgentIds: [],
        });

        const aliceResult = (yield* alice.client.sendRpc(
          AppsListSessions,
          {},
        )) as {
          sessions: Array<{ id: string; initiatorAgentId: string }>;
        };

        expect(aliceResult.sessions.length).toBe(1);
        expect(aliceResult.sessions[0]!.initiatorAgentId).toBe(alice.agentId);

        const bobResult = (yield* bob.client.sendRpc(AppsListSessions, {})) as {
          sessions: Array<{ id: string; initiatorAgentId: string }>;
        };

        expect(bobResult.sessions.length).toBe(1);
        expect(bobResult.sessions[0]!.initiatorAgentId).toBe(bob.agentId);
      }),
    );

    it.live("filters by appId and status", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("list-filter");

        registerTestApp(coreApp, "list-filter-a");
        registerTestApp(coreApp, "list-filter-b");

        const sessionA = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "list-filter-a",
          invitedAgentIds: [],
        })) as { session: { id: string } };

        yield* agent.client.sendRpc(AppsCreate, {
          appId: "list-filter-b",
          invitedAgentIds: [],
        });

        // Close session A
        yield* agent.client.sendRpc(AppsCloseSession, {
          sessionId: sessionA.session.id,
        });

        // Filter by appId
        const byApp = (yield* agent.client.sendRpc(AppsListSessions, {
          appId: "list-filter-a",
        })) as { sessions: Array<{ appId: string }> };
        expect(byApp.sessions.length).toBe(1);
        expect(byApp.sessions[0]!.appId).toBe("list-filter-a");

        // Filter by status
        const active = (yield* agent.client.sendRpc(AppsListSessions, {
          status: "active",
        })) as { sessions: Array<{ status: string }> };
        expect(active.sessions.length).toBe(1);
        expect(active.sessions[0]!.status).toBe("active");

        const closed = (yield* agent.client.sendRpc(AppsListSessions, {
          status: "closed",
        })) as { sessions: Array<{ status: string }> };
        expect(closed.sessions.length).toBe(1);
        expect(closed.sessions[0]!.status).toBe("closed");
      }),
    );

    it.live("applies limit default of 50", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("list-limit");

        registerTestApp(coreApp, "list-limit-app");

        // Create 3 sessions, request limit of 2
        for (let i = 0; i < 3; i++) {
          yield* agent.client.sendRpc(AppsCreate, {
            appId: "list-limit-app",
            invitedAgentIds: [],
          });
        }

        const limited = (yield* agent.client.sendRpc(AppsListSessions, {
          limit: 2,
        })) as { sessions: Array<{ id: string }> };
        expect(limited.sessions.length).toBe(2);

        // Default (no limit param) returns all 3
        const all = (yield* agent.client.sendRpc(AppsListSessions, {})) as {
          sessions: Array<{ id: string }>;
        };
        expect(all.sessions.length).toBe(3);
      }),
    );
  });

  describe("getSession after close", () => {
    it.live("returns closed session with closedAt", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("get-closed");

        registerTestApp(coreApp, "get-closed-app");

        const session = (yield* agent.client.sendRpc(AppsCreate, {
          appId: "get-closed-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string };
        };

        yield* agent.client.sendRpc(AppsCloseSession, {
          sessionId: session.session.id,
        });

        const result = (yield* agent.client.sendRpc(AppsGetSession, {
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
      }),
    );
  });
});
