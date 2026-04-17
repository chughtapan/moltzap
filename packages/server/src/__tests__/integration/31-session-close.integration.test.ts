import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
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
    it.live("emits app/hookTimeout on before_message_delivery timeout", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("bmd-timeout");

        registerTestApp(coreApp, "bmd-timeout-app", { hookTimeoutMs: 200 });

        coreApp.onBeforeMessageDelivery("bmd-timeout-app", async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return { block: true, reason: "never" };
        });

        const session = (yield* agent.client.rpc("apps/create", {
          appId: "bmd-timeout-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        // Fail-closed: send rejects with HookBlocked; event still fires so
        // operators can observe the timeout.
        const sendResult = yield* Effect.either(
          agent.client.rpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "trigger timeout" }],
          }),
        );
        expect(Either.isLeft(sendResult)).toBe(true);
        if (Either.isLeft(sendResult)) {
          expect(sendResult.left.message).toMatch(/timed out/i);
        }

        const timeoutEvent = yield* agent.client.waitForEvent(
          "app/hookTimeout",
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

        const session = (yield* agent.client.rpc("apps/create", {
          appId: "close-timeout-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        yield* agent.client.rpc("apps/closeSession", {
          sessionId: session.session.id,
        });

        const timeoutEvent = yield* agent.client.waitForEvent(
          "app/hookTimeout",
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

        const session = (yield* agent.client.rpc("apps/create", {
          appId: "close-basic-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const result = (yield* agent.client.rpc("apps/closeSession", {
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

        const session = (yield* agent.client.rpc("apps/create", {
          appId: "close-hook-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        yield* agent.client.rpc("apps/closeSession", {
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

        const session = (yield* agent.client.rpc("apps/create", {
          appId: "double-close-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        yield* agent.client.rpc("apps/closeSession", {
          sessionId: session.session.id,
        });

        const result = yield* Effect.either(
          agent.client.rpc("apps/closeSession", {
            sessionId: session.session.id,
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          const rpcErr = result.left as unknown as {
            code: number;
            message: string;
          };
          expect(rpcErr.code).toBe(ErrorCodes.SessionClosed);
        }
      }),
    );

    it.live("rejects close by non-initiator with Forbidden error", () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("close-init");
        const stranger = yield* registerAppAgent("close-stranger");

        registerTestApp(coreApp, "close-forbidden-app");

        const session = (yield* initiator.client.rpc("apps/create", {
          appId: "close-forbidden-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const result = yield* Effect.either(
          stranger.client.rpc("apps/closeSession", {
            sessionId: session.session.id,
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          const rpcErr = result.left as unknown as {
            code: number;
            message: string;
          };
          expect(rpcErr.code).toBe(ErrorCodes.Forbidden);
        }
      }),
    );

    it.live("rejects close of nonexistent session with SessionNotFound", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("close-notfound");

        const result = yield* Effect.either(
          agent.client.rpc("apps/closeSession", {
            sessionId: crypto.randomUUID(),
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          const rpcErr = result.left as unknown as {
            code: number;
            message: string;
          };
          expect(rpcErr.code).toBe(ErrorCodes.SessionNotFound);
        }
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

          const session = (yield* initiator.client.rpc("apps/create", {
            appId: "close-broadcast-app",
            invitedAgentIds: [invitee.agentId],
          })) as {
            session: { id: string; conversations: Record<string, string> };
          };

          yield* invitee.client.waitForEvent("app/participantAdmitted", 5000);

          yield* initiator.client.rpc("apps/closeSession", {
            sessionId: session.session.id,
          });

          const initEvent = yield* initiator.client.waitForEvent(
            "app/sessionClosed",
            3000,
          );
          const invEvent = yield* invitee.client.waitForEvent(
            "app/sessionClosed",
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

    it.live("rejects messages to archived conversations", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("archived-msg");

        registerTestApp(coreApp, "archived-msg-app");

        const session = (yield* agent.client.rpc("apps/create", {
          appId: "archived-msg-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        yield* agent.client.rpc("apps/closeSession", {
          sessionId: session.session.id,
        });

        const result = yield* Effect.either(
          agent.client.rpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "should fail" }],
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          const rpcErr = result.left as unknown as {
            code: number;
            message: string;
          };
          expect(rpcErr.code).toBe(ErrorCodes.ConversationArchived);
        }
      }),
    );

    it.live("excludes archived conversations from conversations/list", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("archived-list");

        registerTestApp(coreApp, "archived-list-app");

        const session = (yield* agent.client.rpc("apps/create", {
          appId: "archived-list-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        // Verify conversation appears before close
        const beforeList = (yield* agent.client.rpc(
          "conversations/list",
          {},
        )) as {
          conversations: Array<{ id: string }>;
        };
        const convId = session.session.conversations["main"]!;
        expect(beforeList.conversations.some((c) => c.id === convId)).toBe(
          true,
        );

        yield* agent.client.rpc("apps/closeSession", {
          sessionId: session.session.id,
        });

        const afterList = (yield* agent.client.rpc(
          "conversations/list",
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
              agent.client.rpc("messages/send", {
                conversationId: mainConvId,
                parts: [{ type: "text", text: "Final message before close" }],
              }),
            );
            finalMessageSent = true;
          }
        });

        const session = (yield* agent.client.rpc("apps/create", {
          appId: "close-final-msg-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        yield* agent.client.rpc("apps/closeSession", {
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

        const created = (yield* agent.client.rpc("apps/create", {
          appId: "get-init-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const result = (yield* agent.client.rpc("apps/getSession", {
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

        const session = (yield* initiator.client.rpc("apps/create", {
          appId: "get-part-app",
          invitedAgentIds: [invitee.agentId],
        })) as {
          session: { id: string };
        };

        yield* invitee.client.waitForEvent("app/participantAdmitted", 5000);

        const result = (yield* invitee.client.rpc("apps/getSession", {
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

          const result = yield* Effect.either(
            agent.client.rpc("apps/getSession", {
              sessionId: crypto.randomUUID(),
            }),
          );
          expect(Either.isLeft(result)).toBe(true);
          if (Either.isLeft(result)) {
            const rpcErr = result.left as unknown as { code: number };
            expect(rpcErr.code).toBe(ErrorCodes.SessionNotFound);
          }
        }),
    );

    it.live("rejects getSession by stranger with Forbidden", () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("get-stranger-init");
        const stranger = yield* registerAppAgent("get-stranger");

        registerTestApp(coreApp, "get-stranger-app");

        const session = (yield* initiator.client.rpc("apps/create", {
          appId: "get-stranger-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string };
        };

        const result = yield* Effect.either(
          stranger.client.rpc("apps/getSession", {
            sessionId: session.session.id,
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          const rpcErr = result.left as unknown as { code: number };
          expect(rpcErr.code).toBe(ErrorCodes.Forbidden);
        }
      }),
    );
  });

  describe("listSessions", () => {
    it.live("returns only caller's sessions", () =>
      Effect.gen(function* () {
        const alice = yield* registerAppAgent("list-alice");
        const bob = yield* registerAppAgent("list-bob");

        registerTestApp(coreApp, "list-app");

        yield* alice.client.rpc("apps/create", {
          appId: "list-app",
          invitedAgentIds: [],
        });

        yield* bob.client.rpc("apps/create", {
          appId: "list-app",
          invitedAgentIds: [],
        });

        const aliceResult = (yield* alice.client.rpc(
          "apps/listSessions",
          {},
        )) as {
          sessions: Array<{ id: string; initiatorAgentId: string }>;
        };

        expect(aliceResult.sessions.length).toBe(1);
        expect(aliceResult.sessions[0]!.initiatorAgentId).toBe(alice.agentId);

        const bobResult = (yield* bob.client.rpc("apps/listSessions", {})) as {
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

        const sessionA = (yield* agent.client.rpc("apps/create", {
          appId: "list-filter-a",
          invitedAgentIds: [],
        })) as { session: { id: string } };

        yield* agent.client.rpc("apps/create", {
          appId: "list-filter-b",
          invitedAgentIds: [],
        });

        // Close session A
        yield* agent.client.rpc("apps/closeSession", {
          sessionId: sessionA.session.id,
        });

        // Filter by appId
        const byApp = (yield* agent.client.rpc("apps/listSessions", {
          appId: "list-filter-a",
        })) as { sessions: Array<{ appId: string }> };
        expect(byApp.sessions.length).toBe(1);
        expect(byApp.sessions[0]!.appId).toBe("list-filter-a");

        // Filter by status
        const active = (yield* agent.client.rpc("apps/listSessions", {
          status: "active",
        })) as { sessions: Array<{ status: string }> };
        expect(active.sessions.length).toBe(1);
        expect(active.sessions[0]!.status).toBe("active");

        const closed = (yield* agent.client.rpc("apps/listSessions", {
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
          yield* agent.client.rpc("apps/create", {
            appId: "list-limit-app",
            invitedAgentIds: [],
          });
        }

        const limited = (yield* agent.client.rpc("apps/listSessions", {
          limit: 2,
        })) as { sessions: Array<{ id: string }> };
        expect(limited.sessions.length).toBe(2);

        // Default (no limit param) returns all 3
        const all = (yield* agent.client.rpc("apps/listSessions", {})) as {
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

        const session = (yield* agent.client.rpc("apps/create", {
          appId: "get-closed-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string };
        };

        yield* agent.client.rpc("apps/closeSession", {
          sessionId: session.session.id,
        });

        const result = (yield* agent.client.rpc("apps/getSession", {
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
