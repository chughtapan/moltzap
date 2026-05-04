import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import { MoltZapApp } from "./app.js";
import {
  AuthError,
  ConversationKeyError,
  InvalidConfigError,
  ManifestRegistrationError,
  SessionError,
  SessionClosedError,
  UserHandlerError,
} from "./errors.js";

import {
  AppsAttestSkill,
  AppsCloseSession,
  AppsCreate,
  AppsGetSession,
  AppsRegister,
  AppParticipantAdmittedNotificationDefinition,
  AppParticipantRejectedNotificationDefinition,
  AppSessionClosedNotificationDefinition,
  AppSessionReadyNotificationDefinition,
  AppSkillChallengeNotificationDefinition,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  SystemPing,
  agentId,
  conversationId,
  decodeNotification,
  messageId,
  notificationFrame,
  notificationGroup,
  type AnyNotificationDefinition,
  type NotificationParamsOf,
} from "@moltzap/protocol";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = agentId("22222222-2222-4222-8222-222222222222");
const CONVERSATION_ID = conversationId("33333333-3333-4333-8333-333333333333");
const MESSAGE_ID = messageId("44444444-4444-4444-8444-444444444444");
const OTHER_CONVERSATION_ID = conversationId(
  "55555555-5555-4555-8555-555555555555",
);
const OTHER_AGENT_ID = agentId("66666666-6666-4666-8666-666666666666");
const CHALLENGE_ID = "77777777-7777-4777-8777-777777777777";

// Mock MoltZapWsClient. Client methods return Effects (primary API), so
// mocks return `Effect.succeed` / `Effect.fail`. Captures constructor
// callbacks so tests can drive server-side notifications.
//
// Spec #222 OQ-4 migration: the per-notification `onNotification`
// constructor option was deleted. Tests fire notifications through the captured
// `subscribe`
// handler instead. The mock's `subscribe` records the handler off the
// `{}`-filter call (the in-repo "every notification" pattern post-OQ-4) and
// exposes it as `_onNotification` so the existing `fireNotification` helper keeps
// working unchanged.
vi.mock("@moltzap/client", () => {
  return {
    MoltZapWsClient: vi
      .fn()
      .mockImplementation(
        (opts: { onReconnect?: unknown; onDisconnect?: unknown }) => {
          let captured: ((e: unknown) => void) | null = null;
          return {
            _onReconnect: opts.onReconnect,
            _onDisconnect: opts.onDisconnect,
            // The app's `start()` calls `subscribe({}, handler)` before
            // `connect()`. We capture the handler so tests can fire
            // notifications at it via `_onNotification`.
            subscribe: vi.fn().mockImplementation((_filter, handler) => {
              captured = (e: unknown) => Effect.runSync(handler(e as never));
              return Effect.succeed({
                id: "sub-mock",
                unsubscribe: Effect.succeed(undefined),
              });
            }),
            get _onNotification(): (e: unknown) => void {
              if (captured === null) {
                throw new Error(
                  "_onNotification fired before subscribe() was called",
                );
              }
              return captured;
            },
            connect: vi
              .fn()
              .mockImplementation(() => Effect.succeed({ agentId: AGENT_ID })),
            sendRpc: vi
              .fn()
              .mockImplementation((definition: { name: string }) => {
                const method = definition.name;
                if (method === AppsRegister.name) {
                  return Effect.succeed({ appId: "test-app" });
                }
                if (method === AppsCreate.name) {
                  return Effect.succeed({
                    session: {
                      id: SESSION_ID,
                      appId: "test-app",
                      initiatorAgentId: AGENT_ID,
                      status: "active",
                      conversations: { default: CONVERSATION_ID },
                      createdAt: "2026-04-16T00:00:00.000Z",
                    },
                  });
                }
                if (method === SystemPing.name) {
                  return Effect.succeed({ ts: new Date().toISOString() });
                }
                if (method === AppsCloseSession.name) {
                  return Effect.succeed({ closed: true });
                }
                if (method === MessagesSend.name) {
                  return Effect.succeed({
                    message: {
                      id: MESSAGE_ID,
                      conversationId: CONVERSATION_ID,
                      senderId: AGENT_ID,
                      parts: [{ type: "text", text: "hello" }],
                      createdAt: "2026-04-16T00:00:00.000Z",
                    },
                  });
                }
                return Effect.succeed({});
              }),
            close: vi.fn().mockImplementation(() => Effect.succeed(undefined)),
            disconnect: vi
              .fn()
              .mockImplementation(() => Effect.succeed(undefined)),
          };
        },
      ),
  };
});

/** Mocked WsClient stashes constructor callbacks as `_on*` fields so tests
 *  can fire them directly. Single cast boundary between mock and real type. */
interface MockedWsClient {
  _onNotification: (e: unknown) => void;
  _onReconnect: () => void;
  _onDisconnect: () => void;
}

const asMock = (c: unknown): MockedWsClient => c as MockedWsClient;

const fireNotification = <D extends AnyNotificationDefinition>(
  app: MoltZapApp,
  definition: D,
  params: NotificationParamsOf<D>,
): void => {
  const frame = notificationFrame(definition, params);
  const notification = Effect.runSync(
    decodeNotification(notificationGroup, frame),
  );
  asMock(app.client)._onNotification(notification);
};

const fireReconnect = (app: MoltZapApp): void =>
  asMock(app.client)._onReconnect();

describe("MoltZapApp", () => {
  let app: MoltZapApp;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new MoltZapApp({
      serverUrl: "ws://localhost:3000",
      agentKey: "test-key",
      appId: "test-app",
    });
  });

  describe("constructor", () => {
    it("requires appId or manifest", () => {
      expect(
        () =>
          new MoltZapApp({
            serverUrl: "ws://localhost:3000",
            agentKey: "test-key",
          }),
      ).toThrow(InvalidConfigError);
    });

    it("builds default manifest from appId", () => {
      const app = new MoltZapApp({
        serverUrl: "ws://localhost:3000",
        agentKey: "test-key",
        appId: "my-app",
      });
      expect(app).toBeDefined();
    });

    it("accepts full manifest", () => {
      const app = new MoltZapApp({
        serverUrl: "ws://localhost:3000",
        agentKey: "test-key",
        manifest: {
          appId: "full-app",
          name: "Full App",
          conversations: [
            { key: "main", name: "Main", participantFilter: "all" },
          ],
        },
      });
      expect(app).toBeDefined();
    });

    it("exposes client as escape hatch", () => {
      expect(app.client).toBeDefined();
    });
  });

  describe("start()", () => {
    it("connects, registers manifest, and creates session", async () => {
      const session = await Effect.runPromise(app.start());
      expect(session.id).toBe(SESSION_ID);
      expect(session.appId).toBe("test-app");
      expect(session.isActive).toBe(true);

      expect(app.client.connect).toHaveBeenCalledTimes(1);
      expect(app.client.sendRpc).toHaveBeenCalledWith(AppsRegister, {
        manifest: expect.objectContaining({ appId: "test-app" }),
      });
      expect(app.client.sendRpc).toHaveBeenCalledWith(AppsCreate, {
        appId: "test-app",
        invitedAgentIds: [],
      });
    });

    it("startAsync() is a Promise bridge over start()", async () => {
      const session = await app.startAsync();
      expect(session.id).toBe(SESSION_ID);
    });

    it("fires onSessionReady for already-active sessions", async () => {
      const handler = vi.fn();
      app.onSessionReady(handler);

      await Effect.runPromise(app.start());

      await new Promise((r) => setTimeout(r, 0));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0].id).toBe(SESSION_ID);
    });
  });

  describe("stop()", () => {
    it("closes sessions and the client", async () => {
      await Effect.runPromise(app.start());
      await Effect.runPromise(app.stop());

      expect(app.client.sendRpc).toHaveBeenCalledWith(AppsCloseSession, {
        sessionId: SESSION_ID,
      });
      expect(app.client.close).toHaveBeenCalledTimes(1);
    });

    it("succeeds even when apps/closeSession fails (failure is swallowed by Effect.ignore)", async () => {
      await Effect.runPromise(app.start());

      // After start, the next sendRpc("apps/closeSession") must fail. The
      // mock's default sendRpc handles that method with Effect.succeed —
      // override it for the closeSession call only so the apps/closeSession
      // path goes down the error branch.
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((definition: { name: string }) => {
        const method = definition.name;
        if (method === AppsCloseSession.name) {
          return Effect.fail(new Error("server rejected closeSession"));
        }
        return Effect.succeed({});
      });

      // stop() must still complete cleanly. The contract is "best-effort
      // cleanup" — a closeSession failure on shutdown should not propagate.
      const exit = await Effect.runPromiseExit(app.stop());
      expect(Exit.isSuccess(exit)).toBe(true);

      expect(app.client.sendRpc).toHaveBeenCalledWith(AppsCloseSession, {
        sessionId: SESSION_ID,
      });
      expect(app.client.close).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes the notification subscription on shutdown", async () => {
      const subscribe = app.client.subscribe as ReturnType<typeof vi.fn>;
      let unsubscribeCalled = false;
      subscribe.mockImplementationOnce(() =>
        Effect.succeed({
          id: "sub-shutdown-test",
          unsubscribe: Effect.sync(() => {
            unsubscribeCalled = true;
          }),
        }),
      );

      await Effect.runPromise(app.start());
      await Effect.runPromise(app.stop());
      expect(unsubscribeCalled).toBe(true);
    });
  });

  describe("session management", () => {
    it("getSession returns the session by ID", async () => {
      await Effect.runPromise(app.start());
      const session = app.getSession(SESSION_ID);
      expect(session).toBeDefined();
      expect(session!.id).toBe(SESSION_ID);
    });

    it("getSession returns undefined for unknown ID", async () => {
      await Effect.runPromise(app.start());
      expect(app.getSession("unknown")).toBeUndefined();
    });

    it("activeSessions returns active sessions", async () => {
      await Effect.runPromise(app.start());
      expect(app.activeSessions).toHaveLength(1);
    });
  });

  describe("messaging", () => {
    it("send() resolves conversation key and sends", async () => {
      await Effect.runPromise(app.start());
      await Effect.runPromise(
        app.send("default", [{ type: "text", text: "hello" }]),
      );

      expect(app.client.sendRpc).toHaveBeenCalledWith(MessagesSend, {
        conversationId: CONVERSATION_ID,
        parts: [{ type: "text", text: "hello" }],
      });
    });

    it("send() fails with ConversationKeyError for unknown key", async () => {
      await Effect.runPromise(app.start());
      const exit = await Effect.runPromiseExit(
        app.send("nonexistent", [{ type: "text", text: "hello" }]),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(ConversationKeyError);
      } else {
        throw new Error("expected typed Fail");
      }
    });

    it("sendTo() sends by raw conversation ID", async () => {
      await Effect.runPromise(app.start());
      await Effect.runPromise(
        app.sendTo(CONVERSATION_ID, [{ type: "text", text: "hello" }]),
      );

      expect(app.client.sendRpc).toHaveBeenCalledWith(MessagesSend, {
        conversationId: CONVERSATION_ID,
        parts: [{ type: "text", text: "hello" }],
      });
    });

    it("reply() sends replyToId; server resolves the target conversation", async () => {
      await Effect.runPromise(app.start());
      await Effect.runPromise(
        app.reply(MESSAGE_ID, [{ type: "text", text: "reply" }]),
      );

      expect(app.client.sendRpc).toHaveBeenCalledWith(MessagesSend, {
        replyToId: MESSAGE_ID,
        parts: [{ type: "text", text: "reply" }],
      });
    });

    it("sendAsync() is a Promise bridge over send()", async () => {
      await Effect.runPromise(app.start());
      await app.sendAsync("default", [{ type: "text", text: "hello" }]);

      expect(app.client.sendRpc).toHaveBeenCalledWith(MessagesSend, {
        conversationId: CONVERSATION_ID,
        parts: [{ type: "text", text: "hello" }],
      });
    });
  });

  describe("sessionReady dedup", () => {
    it("fires handlers once even when apps/create returns active AND app/sessionReady notification arrives", async () => {
      const handler = vi.fn();
      app.onSessionReady(handler);

      await Effect.runPromise(app.start());
      await new Promise((r) => setTimeout(r, 0));
      expect(handler).toHaveBeenCalledTimes(1);

      fireNotification(app, AppSessionReadyNotificationDefinition, {
        sessionId: SESSION_ID,
        conversations: { default: CONVERSATION_ID },
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("notification dispatch", () => {
    const inboundMessage = {
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: OTHER_AGENT_ID,
      parts: [{ type: "text", text: "hi" }],
      createdAt: "2026-04-16T00:00:00.000Z",
    };

    it("onMessage fires the key-specific handler with the message", async () => {
      const handler = vi.fn();
      app.onMessage("default", handler);

      await Effect.runPromise(app.start());
      fireNotification(app, MessageReceivedNotificationDefinition, {
        message: inboundMessage,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(inboundMessage);
    });

    it("onMessage catch-all '*' fires for every message", async () => {
      const starHandler = vi.fn();
      app.onMessage("*", starHandler);

      await Effect.runPromise(app.start());
      fireNotification(app, MessageReceivedNotificationDefinition, {
        message: inboundMessage,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(starHandler).toHaveBeenCalledWith(inboundMessage);
    });

    it("onMessage ignores messages whose conversationId maps to no key (no catch-all)", async () => {
      const handler = vi.fn();
      app.onMessage("default", handler);

      await Effect.runPromise(app.start());
      fireNotification(app, MessageReceivedNotificationDefinition, {
        message: { ...inboundMessage, conversationId: OTHER_CONVERSATION_ID },
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(handler).not.toHaveBeenCalled();
    });

    it("emits UserHandlerError via onError when a message handler throws", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);
      app.onMessage("default", () => {
        throw new Error("boom");
      });

      await Effect.runPromise(app.start());
      fireNotification(app, MessageReceivedNotificationDefinition, {
        message: inboundMessage,
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(errorHandler).toHaveBeenCalledTimes(1);
      const err = errorHandler.mock.calls[0]![0];
      expect(err).toBeInstanceOf(UserHandlerError);
    });

    it("onParticipantAdmitted fires on app/participantAdmitted", async () => {
      const handler = vi.fn();
      app.onParticipantAdmitted(handler);

      await Effect.runPromise(app.start());
      const payload = {
        sessionId: SESSION_ID,
        agentId: OTHER_AGENT_ID,
      };
      fireNotification(
        app,
        AppParticipantAdmittedNotificationDefinition,
        payload,
      );

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it("onParticipantRejected fires on app/participantRejected", async () => {
      const handler = vi.fn();
      app.onParticipantRejected(handler);

      await Effect.runPromise(app.start());
      const payload = {
        sessionId: SESSION_ID,
        agentId: OTHER_AGENT_ID,
        reason: "identity check failed",
        stage: "identity",
        rejectionCode: "NotInContacts",
      };
      fireNotification(
        app,
        AppParticipantRejectedNotificationDefinition,
        payload,
      );

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it("app/sessionClosed removes the session and emits SessionClosedError", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);

      await Effect.runPromise(app.start());
      expect(app.getSession(SESSION_ID)).toBeDefined();

      fireNotification(app, AppSessionClosedNotificationDefinition, {
        sessionId: SESSION_ID,
        closedBy: AGENT_ID,
      });

      expect(app.getSession(SESSION_ID)).toBeUndefined();
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler.mock.calls[0]![0]).toBeInstanceOf(SessionClosedError);
    });

    it("app/skillChallenge auto-responds with apps/attestSkill when manifest.skillUrl is set", async () => {
      const appWithSkill = new MoltZapApp({
        serverUrl: "ws://localhost:3000",
        agentKey: "test-key",
        manifest: {
          appId: "skilled",
          name: "Skilled",
          skillUrl: "https://example.com/skill",
          skillMinVersion: "1.2.3",
          conversations: [
            { key: "default", name: "Skilled", participantFilter: "all" },
          ],
        },
      });

      await Effect.runPromise(appWithSkill.start());
      fireNotification(appWithSkill, AppSkillChallengeNotificationDefinition, {
        challengeId: CHALLENGE_ID,
        sessionId: SESSION_ID,
        appId: "skilled",
        skillUrl: "https://example.com/skill",
      });

      expect(appWithSkill.client.sendRpc).toHaveBeenCalledWith(
        AppsAttestSkill,
        {
          challengeId: CHALLENGE_ID,
          skillUrl: "https://example.com/skill",
          version: "1.2.3",
        },
      );
    });

    it("app/skillChallenge is a no-op when manifest.skillUrl is absent", async () => {
      await Effect.runPromise(app.start());
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockClear();

      fireNotification(app, AppSkillChallengeNotificationDefinition, {
        challengeId: CHALLENGE_ID,
        sessionId: SESSION_ID,
        appId: "test-app",
        skillUrl: "https://example.com/skill",
      });

      expect(sendRpc).not.toHaveBeenCalledWith(
        AppsAttestSkill,
        expect.anything(),
      );
    });
  });

  describe("start() error branches", () => {
    it("fails with AuthError when connect fails", async () => {
      const connect = app.client.connect as ReturnType<typeof vi.fn>;
      connect.mockImplementationOnce(() => Effect.fail(new Error("tcp reset")));

      const exit = await Effect.runPromiseExit(app.start());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(AuthError);
      } else {
        throw new Error("expected typed Fail");
      }
    });

    it("fails with ManifestRegistrationError when apps/register fails", async () => {
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((definition: { name: string }) => {
        const method = definition.name;
        if (method === AppsRegister.name) {
          return Effect.fail(new Error("manifest invalid"));
        }
        return Effect.succeed({});
      });

      const exit = await Effect.runPromiseExit(app.start());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(ManifestRegistrationError);
      } else {
        throw new Error("expected typed Fail");
      }
    });

    it("unsubscribes the notification subscription when start() fails after subscribe", async () => {
      const subscribe = app.client.subscribe as ReturnType<typeof vi.fn>;
      let unsubscribeCalled = false;
      subscribe.mockImplementationOnce(() =>
        Effect.succeed({
          id: "sub-leak-test",
          unsubscribe: Effect.sync(() => {
            unsubscribeCalled = true;
          }),
        }),
      );

      const connect = app.client.connect as ReturnType<typeof vi.fn>;
      connect.mockImplementationOnce(() => Effect.fail(new Error("tcp reset")));

      const exit = await Effect.runPromiseExit(app.start());
      expect(Exit.isFailure(exit)).toBe(true);
      expect(unsubscribeCalled).toBe(true);
    });

    it("fails with SessionError when apps/create fails", async () => {
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc
        .mockImplementationOnce(() => Effect.succeed({ appId: "test-app" }))
        .mockImplementationOnce(() =>
          Effect.fail(new Error("capacity exhausted")),
        );

      const exit = await Effect.runPromiseExit(app.start());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(SessionError);
      } else {
        throw new Error("expected typed Fail");
      }
    });
  });

  describe("reconnect recovery", () => {
    const triggerReconnect = async (): Promise<void> => {
      fireReconnect(app);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    };

    it("on reconnect with active session, refreshes session via apps/getSession", async () => {
      await Effect.runPromise(app.start());
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((definition: { name: string }) => {
        const method = definition.name;
        if (method === AppsGetSession.name) {
          return Effect.succeed({
            session: {
              id: SESSION_ID,
              appId: "test-app",
              initiatorAgentId: AGENT_ID,
              status: "active",
              conversations: {
                default: CONVERSATION_ID,
                extra: OTHER_CONVERSATION_ID,
              },
              createdAt: "2026-04-16T00:00:00.000Z",
            },
          });
        }
        return Effect.succeed({});
      });

      await triggerReconnect();

      expect(sendRpc).toHaveBeenCalledWith(AppsGetSession, {
        sessionId: SESSION_ID,
      });
      expect(app.getSession(SESSION_ID)!.conversations.extra).toBe(
        OTHER_CONVERSATION_ID,
      );
    });

    it("on reconnect with closed session, removes it and emits SessionClosedError", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);

      await Effect.runPromise(app.start());
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((definition: { name: string }) => {
        const method = definition.name;
        if (method === AppsGetSession.name) {
          return Effect.succeed({
            session: {
              id: SESSION_ID,
              appId: "test-app",
              initiatorAgentId: AGENT_ID,
              status: "closed",
              conversations: { default: CONVERSATION_ID },
              createdAt: "2026-04-16T00:00:00.000Z",
            },
          });
        }
        return Effect.succeed({});
      });

      await triggerReconnect();

      expect(app.getSession(SESSION_ID)).toBeUndefined();
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ _tag: "SessionClosedError" }),
      );
    });

    it("on reconnect when apps/getSession fails, emits SessionError", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);

      await Effect.runPromise(app.start());
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((definition: { name: string }) => {
        const method = definition.name;
        if (method === AppsGetSession.name) {
          return Effect.fail(new Error("network gone"));
        }
        return Effect.succeed({});
      });

      await triggerReconnect();

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ _tag: "SessionError" }),
      );
      expect(app.getSession(SESSION_ID)).toBeDefined();
    });
  });
});
