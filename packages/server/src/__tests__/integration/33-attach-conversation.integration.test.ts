// ─────────────────────────────────────────────────────────────────────
// attachConversation integration coverage (issue #85).
//
// Exercises `CoreApp.attachAppConversation` end-to-end: validates session
// lifecycle handling, idempotency and conflict detection, and verifies
// that `before_message_delivery` fires on conversations registered after
// the session was created (which is the whole point of the API — dynamic
// conversations like per-participant role DMs bypass the hook pipeline
// unless attached).
//
// Real wall-clock timing; PGlite; real WS clients.
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either, Exit } from "effect";

import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";
import type { CoreApp } from "../../app/types.js";
import type { ConnectedAgent } from "../../test-utils/helpers.js";
import { ErrorCodes } from "@moltzap/protocol";
import { RpcFailure } from "../../runtime/index.js";

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

function registerTestApp(app: CoreApp, appId: string) {
  app.registerApp({
    appId,
    name: `Test App ${appId}`,
    permissions: { required: [], optional: [] },
    conversations: [
      { key: "main", name: "Main Channel", participantFilter: "all" },
    ],
    hooks: {
      before_message_delivery: { timeout_ms: 5000 },
    },
  });
}

/** Create a bare app session (zero invitees) that goes `active` immediately. */
function createSoloSession(
  app: CoreApp,
  agent: ConnectedAgent,
  appId: string,
): Effect.Effect<{ sessionId: string }, Error> {
  return Effect.gen(function* () {
    const res = (yield* agent.client.sendRpc("apps/create", {
      appId,
      invitedAgentIds: [],
    })) as { session: { id: string } };
    return { sessionId: res.session.id };
  });
}

describe("Scenario 33: attachConversation", () => {
  it.live("attaches a dynamic DM and inserts one row", () =>
    Effect.gen(function* () {
      const initiator = yield* registerAppAgent("attach-init");
      const peer = yield* registerAppAgent("attach-peer");

      registerTestApp(coreApp, "attach-basic");

      const { sessionId } = yield* createSoloSession(
        coreApp,
        initiator,
        "attach-basic",
      );

      const dm = (yield* initiator.client.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: peer.agentId }],
      })) as { conversation: { id: string } };
      const dmId = dm.conversation.id;

      yield* coreApp.attachAppConversation(sessionId, dmId, "role_dm_peer");

      const db = getKyselyDb();
      const rows = yield* Effect.tryPromise(() =>
        db
          .selectFrom("app_session_conversations")
          .select(["conversation_key", "conversation_id"])
          .where("session_id", "=", sessionId)
          .where("conversation_id", "=", dmId)
          .execute(),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.conversation_key).toBe("role_dm_peer");
    }),
  );

  it.live("is idempotent on exact (sessionId, convId, key)", () =>
    Effect.gen(function* () {
      const initiator = yield* registerAppAgent("attach-idem-init");
      const peer = yield* registerAppAgent("attach-idem-peer");

      registerTestApp(coreApp, "attach-idem");

      const { sessionId } = yield* createSoloSession(
        coreApp,
        initiator,
        "attach-idem",
      );

      const dm = (yield* initiator.client.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: peer.agentId }],
      })) as { conversation: { id: string } };
      const dmId = dm.conversation.id;

      yield* coreApp.attachAppConversation(sessionId, dmId, "role_dm_peer");
      yield* coreApp.attachAppConversation(sessionId, dmId, "role_dm_peer");

      const db = getKyselyDb();
      const rows = yield* Effect.tryPromise(() =>
        db
          .selectFrom("app_session_conversations")
          .select(["conversation_key", "conversation_id"])
          .where("session_id", "=", sessionId)
          .where("conversation_id", "=", dmId)
          .execute(),
      );
      expect(rows).toHaveLength(1);
    }),
  );

  it.live(
    "rejects a second attach with a different key for the same convId",
    () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("attach-keyswap-init");
        const peer = yield* registerAppAgent("attach-keyswap-peer");

        registerTestApp(coreApp, "attach-keyswap");

        const { sessionId } = yield* createSoloSession(
          coreApp,
          initiator,
          "attach-keyswap",
        );

        const dm = (yield* initiator.client.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: peer.agentId }],
        })) as { conversation: { id: string } };
        const dmId = dm.conversation.id;

        yield* coreApp.attachAppConversation(sessionId, dmId, "role_dm_a");

        const second = yield* Effect.exit(
          coreApp.attachAppConversation(sessionId, dmId, "role_dm_b"),
        );
        expect(Exit.isFailure(second)).toBe(true);
        if (Exit.isFailure(second)) {
          // The Cause wraps an RpcFailure; the RpcFailure-code assertion has
          // its own dedicated test below. Here we just confirm the message
          // surfaces the conflict.
          expect(JSON.stringify(second.cause)).toContain("already attached");
        }
      }),
  );

  it.live(
    "rejects a second attach with a different convId for the same key",
    () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("attach-convswap-init");
        const peerA = yield* registerAppAgent("attach-convswap-a");
        const peerB = yield* registerAppAgent("attach-convswap-b");

        registerTestApp(coreApp, "attach-convswap");

        const { sessionId } = yield* createSoloSession(
          coreApp,
          initiator,
          "attach-convswap",
        );

        const dmA = (yield* initiator.client.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: peerA.agentId }],
        })) as { conversation: { id: string } };
        const dmB = (yield* initiator.client.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: peerB.agentId }],
        })) as { conversation: { id: string } };

        yield* coreApp.attachAppConversation(
          sessionId,
          dmA.conversation.id,
          "role_dm",
        );

        const second = yield* Effect.exit(
          coreApp.attachAppConversation(
            sessionId,
            dmB.conversation.id,
            "role_dm",
          ),
        );
        expect(Exit.isFailure(second)).toBe(true);
        if (Exit.isFailure(second)) {
          expect(JSON.stringify(second.cause)).toContain(
            "is already in use for session",
          );
        }
      }),
  );

  it.live("rejects attach to a closed session", () =>
    Effect.gen(function* () {
      const initiator = yield* registerAppAgent("attach-closed-init");
      const peer = yield* registerAppAgent("attach-closed-peer");

      registerTestApp(coreApp, "attach-closed");

      const { sessionId } = yield* createSoloSession(
        coreApp,
        initiator,
        "attach-closed",
      );

      yield* initiator.client.sendRpc("apps/closeSession", { sessionId });

      const dm = (yield* initiator.client.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: peer.agentId }],
      })) as { conversation: { id: string } };

      const result = yield* Effect.exit(
        coreApp.attachAppConversation(sessionId, dm.conversation.id, "role_dm"),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        // RpcFailure { code: SessionClosed } comes through as a tagged error.
        const flat = JSON.stringify(result.cause);
        expect(flat).toMatch(/closed session/i);
      }
    }),
  );

  it.live(
    "rejects attach of a conversation already tied to another session",
    () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("attach-xsess-init");
        const peer = yield* registerAppAgent("attach-xsess-peer");

        registerTestApp(coreApp, "attach-xsess");

        const a = yield* createSoloSession(coreApp, initiator, "attach-xsess");
        const b = yield* createSoloSession(coreApp, initiator, "attach-xsess");

        const dm = (yield* initiator.client.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: peer.agentId }],
        })) as { conversation: { id: string } };

        yield* coreApp.attachAppConversation(
          a.sessionId,
          dm.conversation.id,
          "role_dm",
        );

        const second = yield* Effect.exit(
          coreApp.attachAppConversation(
            b.sessionId,
            dm.conversation.id,
            "role_dm",
          ),
        );
        expect(Exit.isFailure(second)).toBe(true);
        if (Exit.isFailure(second)) {
          expect(JSON.stringify(second.cause)).toMatch(/already attached/);
        }
      }),
  );

  it.live(
    "before_message_delivery fires on an attached conversation (patch path)",
    () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("attach-hook-init");
        const peer = yield* registerAppAgent("attach-hook-peer");

        registerTestApp(coreApp, "attach-hook");

        coreApp.onBeforeMessageDelivery("attach-hook", (ctx) => ({
          block: false,
          patch: {
            parts: [
              {
                type: "text" as const,
                text:
                  "[ATTACHED] " +
                  (ctx.message.parts[0] as { text: string }).text,
              },
            ],
          },
        }));

        const { sessionId } = yield* createSoloSession(
          coreApp,
          initiator,
          "attach-hook",
        );

        const dm = (yield* initiator.client.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: peer.agentId }],
        })) as { conversation: { id: string } };
        const dmId = dm.conversation.id;

        // Sanity: before attaching, the hook is bypassed — the convId is not
        // in AppHost.conversationToSession, so runBeforeMessageDelivery
        // returns null and the message passes through unchanged.
        const preAttach = (yield* initiator.client.sendRpc("messages/send", {
          conversationId: dmId,
          parts: [{ type: "text", text: "pre-attach" }],
        })) as { message: { parts: Array<{ text: string }> } };
        expect(preAttach.message.parts[0]!.text).toBe("pre-attach");

        yield* coreApp.attachAppConversation(sessionId, dmId, "role_dm");

        // Post-attach: hook fires and patches the parts.
        const postAttach = (yield* initiator.client.sendRpc("messages/send", {
          conversationId: dmId,
          parts: [{ type: "text", text: "post-attach" }],
        })) as {
          message: { parts: Array<{ text: string }>; patchedBy?: string };
        };
        expect(postAttach.message.parts[0]!.text).toBe(
          "[ATTACHED] post-attach",
        );
        expect(postAttach.message.patchedBy).toBe("attach-hook");
      }),
  );

  // Non-regression: hard proof the returned error is an RpcFailure with a
  // Conflict code, not some other channel. The JSON-stringified Cause checks
  // above are cheap but don't verify the error class.
  it.live("conflict surfaces as RpcFailure with Conflict code", () =>
    Effect.gen(function* () {
      const initiator = yield* registerAppAgent("attach-ecode-init");
      const peer = yield* registerAppAgent("attach-ecode-peer");

      registerTestApp(coreApp, "attach-ecode");

      const { sessionId } = yield* createSoloSession(
        coreApp,
        initiator,
        "attach-ecode",
      );
      const dm = (yield* initiator.client.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: peer.agentId }],
      })) as { conversation: { id: string } };

      yield* coreApp.attachAppConversation(
        sessionId,
        dm.conversation.id,
        "role_dm",
      );
      const either = yield* Effect.either(
        coreApp.attachAppConversation(
          sessionId,
          dm.conversation.id,
          "role_dm_two",
        ),
      );
      expect(Either.isLeft(either)).toBe(true);
      if (Either.isLeft(either)) {
        expect(either.left).toBeInstanceOf(RpcFailure);
        expect(either.left.code).toBe(ErrorCodes.Conflict);
      }
    }),
  );
});
