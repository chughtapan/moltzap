import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import { MoltZapApp } from "./app.js";
import {
  AppError,
  AuthError,
  ManifestRegistrationError,
  SessionError,
} from "./errors.js";

// Mock MoltZapWsClient. Client methods return Effects (primary API), so
// mocks return `Effect.succeed` / `Effect.fail`. Captures constructor
// callbacks so tests can drive server-side events.
//
// Spec #222 OQ-4 migration: the per-event `onEvent` constructor option
// was deleted. Tests fire events through the captured `subscribe`
// handler instead. The mock's `subscribe` records the handler off the
// `{}`-filter call (the in-repo "every event" pattern post-OQ-4) and
// exposes it as `_onEvent` so the existing `fireEvent` helper keeps
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
            // events at it via `_onEvent`.
            subscribe: vi.fn().mockImplementation((_filter, handler) => {
              captured = (e: unknown) => Effect.runSync(handler(e as never));
              return Effect.succeed({
                id: "sub-mock",
                unsubscribe: Effect.succeed(undefined),
              });
            }),
            get _onEvent(): (e: unknown) => void {
              if (captured === null) {
                throw new Error("_onEvent fired before subscribe() was called");
              }
              return captured;
            },
            connect: vi
              .fn()
              .mockImplementation(() => Effect.succeed({ agentId: "agent-1" })),
            sendRpc: vi.fn().mockImplementation((method: string) => {
              if (method === "apps/register") {
                return Effect.succeed({ appId: "test-app" });
              }
              if (method === "apps/create") {
                return Effect.succeed({
                  session: {
                    id: "session-1",
                    appId: "test-app",
                    initiatorAgentId: "agent-1",
                    status: "active",
                    conversations: { default: "conv-1" },
                    createdAt: "2026-04-16T00:00:00.000Z",
                  },
                });
              }
              if (method === "system/ping") {
                return Effect.succeed({ ts: new Date().toISOString() });
              }
              if (method === "apps/closeSession") {
                return Effect.succeed({ closed: true });
              }
              if (method === "messages/send") {
                return Effect.succeed({
                  message: {
                    id: "msg-1",
                    conversationId: "conv-1",
                    senderId: "agent-1",
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
  _onEvent: (e: unknown) => void;
  _onReconnect: () => void;
  _onDisconnect: () => void;
}

// #ignore-sloppy-code-next-line[as-unknown-as]: mock boundary — real MoltZapWsClient has no _on* fields
const asMock = (c: unknown): MockedWsClient => c as MockedWsClient;

const fireEvent = (
  app: MoltZapApp,
  event: string,
  data: Record<string, unknown>,
): void => asMock(app.client)._onEvent({ type: "event", event, data });

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
      ).toThrow(AppError);
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
          permissions: { required: [], optional: [] },
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
      expect(session.id).toBe("session-1");
      expect(session.appId).toBe("test-app");
      expect(session.isActive).toBe(true);

      expect(app.client.connect).toHaveBeenCalledTimes(1);
      expect(app.client.sendRpc).toHaveBeenCalledWith("apps/register", {
        manifest: expect.objectContaining({ appId: "test-app" }),
      });
      expect(app.client.sendRpc).toHaveBeenCalledWith("apps/create", {
        appId: "test-app",
        invitedAgentIds: [],
      });
    });

    it("startAsync() is a Promise bridge over start()", async () => {
      const session = await app.startAsync();
      expect(session.id).toBe("session-1");
    });

    it("fires onSessionReady for already-active sessions", async () => {
      const handler = vi.fn();
      app.onSessionReady(handler);

      await Effect.runPromise(app.start());

      await new Promise((r) => setTimeout(r, 0));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0].id).toBe("session-1");
    });
  });

  describe("stop()", () => {
    it("closes sessions and the client", async () => {
      await Effect.runPromise(app.start());
      await Effect.runPromise(app.stop());

      expect(app.client.sendRpc).toHaveBeenCalledWith("apps/closeSession", {
        sessionId: "session-1",
      });
      expect(app.client.close).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes the event subscription on shutdown", async () => {
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
      const session = app.getSession("session-1");
      expect(session).toBeDefined();
      expect(session!.id).toBe("session-1");
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

      expect(app.client.sendRpc).toHaveBeenCalledWith("messages/send", {
        conversationId: "conv-1",
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
        expect(exit.cause.error.code).toBe("UNKNOWN_CONVERSATION_KEY");
      } else {
        throw new Error("expected typed Fail");
      }
    });

    it("sendTo() sends by raw conversation ID", async () => {
      await Effect.runPromise(app.start());
      await Effect.runPromise(
        app.sendTo("conv-1", [{ type: "text", text: "hello" }]),
      );

      expect(app.client.sendRpc).toHaveBeenCalledWith("messages/send", {
        conversationId: "conv-1",
        parts: [{ type: "text", text: "hello" }],
      });
    });

    it("reply() sends replyToId; server resolves the target conversation", async () => {
      await Effect.runPromise(app.start());
      await Effect.runPromise(
        app.reply("msg-1", [{ type: "text", text: "reply" }]),
      );

      expect(app.client.sendRpc).toHaveBeenCalledWith("messages/send", {
        replyToId: "msg-1",
        parts: [{ type: "text", text: "reply" }],
      });
    });

    it("sendAsync() is a Promise bridge over send()", async () => {
      await Effect.runPromise(app.start());
      await app.sendAsync("default", [{ type: "text", text: "hello" }]);

      expect(app.client.sendRpc).toHaveBeenCalledWith("messages/send", {
        conversationId: "conv-1",
        parts: [{ type: "text", text: "hello" }],
      });
    });
  });

  describe("sessionReady dedup", () => {
    it("fires handlers once even when apps/create returns active AND app/sessionReady event arrives", async () => {
      const handler = vi.fn();
      app.onSessionReady(handler);

      await Effect.runPromise(app.start());
      await new Promise((r) => setTimeout(r, 0));
      expect(handler).toHaveBeenCalledTimes(1);

      fireEvent(app, "app/sessionReady", {
        sessionId: "session-1",
        conversations: { default: "conv-1" },
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("event dispatch", () => {
    const inboundMessage = {
      id: "msg-42",
      conversationId: "conv-1",
      senderId: "agent-2",
      parts: [{ type: "text", text: "hi" }],
      createdAt: "2026-04-16T00:00:00.000Z",
    };

    it("onMessage fires the key-specific handler with the message", async () => {
      const handler = vi.fn();
      app.onMessage("default", handler);

      await Effect.runPromise(app.start());
      fireEvent(app, "messages/received", { message: inboundMessage });
      await new Promise((r) => setTimeout(r, 0));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(inboundMessage);
    });

    it("onMessage catch-all '*' fires for every message", async () => {
      const starHandler = vi.fn();
      app.onMessage("*", starHandler);

      await Effect.runPromise(app.start());
      fireEvent(app, "messages/received", { message: inboundMessage });
      await new Promise((r) => setTimeout(r, 0));

      expect(starHandler).toHaveBeenCalledWith(inboundMessage);
    });

    it("onMessage ignores messages whose conversationId maps to no key (no catch-all)", async () => {
      const handler = vi.fn();
      app.onMessage("default", handler);

      await Effect.runPromise(app.start());
      fireEvent(app, "messages/received", {
        message: { ...inboundMessage, conversationId: "conv-unknown" },
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(handler).not.toHaveBeenCalled();
    });

    it("emits HANDLER_ERROR via onError when a message handler throws", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);
      app.onMessage("default", () => {
        throw new Error("boom");
      });

      await Effect.runPromise(app.start());
      fireEvent(app, "messages/received", { message: inboundMessage });

      await new Promise((r) => setTimeout(r, 0));

      expect(errorHandler).toHaveBeenCalledTimes(1);
      const err = errorHandler.mock.calls[0]![0] as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe("HANDLER_ERROR");
    });

    it("onParticipantAdmitted fires on app/participantAdmitted", async () => {
      const handler = vi.fn();
      app.onParticipantAdmitted(handler);

      await Effect.runPromise(app.start());
      const event = {
        sessionId: "session-1",
        agentId: "agent-9",
        grantedResources: ["messages"],
      };
      fireEvent(app, "app/participantAdmitted", event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("onParticipantRejected fires on app/participantRejected", async () => {
      const handler = vi.fn();
      app.onParticipantRejected(handler);

      await Effect.runPromise(app.start());
      const event = {
        sessionId: "session-1",
        agentId: "agent-9",
        reason: "identity check failed",
        stage: "identity",
        rejectionCode: "NOT_CONTACT",
      };
      fireEvent(app, "app/participantRejected", event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("app/sessionClosed removes the session and emits SessionClosedError", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);

      await Effect.runPromise(app.start());
      expect(app.getSession("session-1")).toBeDefined();

      fireEvent(app, "app/sessionClosed", { sessionId: "session-1" });

      expect(app.getSession("session-1")).toBeUndefined();
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler.mock.calls[0]![0].code).toBe("SESSION_CLOSED");
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
          permissions: { required: [], optional: [] },
          conversations: [
            { key: "default", name: "Skilled", participantFilter: "all" },
          ],
        },
      });

      await Effect.runPromise(appWithSkill.start());
      fireEvent(appWithSkill, "app/skillChallenge", { challengeId: "chal-1" });

      expect(appWithSkill.client.sendRpc).toHaveBeenCalledWith(
        "apps/attestSkill",
        {
          challengeId: "chal-1",
          skillUrl: "https://example.com/skill",
          version: "1.2.3",
        },
      );
    });

    it("app/skillChallenge is a no-op when manifest.skillUrl is absent", async () => {
      await Effect.runPromise(app.start());
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockClear();

      fireEvent(app, "app/skillChallenge", { challengeId: "chal-1" });

      expect(sendRpc).not.toHaveBeenCalledWith(
        "apps/attestSkill",
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
        expect(exit.cause.error.code).toBe("AUTH_FAILED");
      } else {
        throw new Error("expected typed Fail");
      }
    });

    it("unsubscribes the event subscription when start() fails after subscribe", async () => {
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

    it("fails with ManifestRegistrationError when apps/register fails", async () => {
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((method: string) => {
        if (method === "apps/register") {
          return Effect.fail(new Error("manifest invalid"));
        }
        return Effect.succeed({});
      });

      const exit = await Effect.runPromiseExit(app.start());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(ManifestRegistrationError);
        expect(exit.cause.error.code).toBe("MANIFEST_REJECTED");
      } else {
        throw new Error("expected typed Fail");
      }
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
        expect(exit.cause.error.code).toBe("SESSION_ERROR");
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
      sendRpc.mockImplementationOnce((method: string) => {
        if (method === "apps/getSession") {
          return Effect.succeed({
            session: {
              id: "session-1",
              appId: "test-app",
              initiatorAgentId: "agent-1",
              status: "active",
              conversations: { default: "conv-1", extra: "conv-2" },
              createdAt: "2026-04-16T00:00:00.000Z",
            },
          });
        }
        return Effect.succeed({});
      });

      await triggerReconnect();

      expect(sendRpc).toHaveBeenCalledWith("apps/getSession", {
        sessionId: "session-1",
      });
      expect(app.getSession("session-1")!.conversations.extra).toBe("conv-2");
    });

    it("on reconnect with closed session, removes it and emits SessionClosedError", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);

      await Effect.runPromise(app.start());
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((method: string) => {
        if (method === "apps/getSession") {
          return Effect.succeed({
            session: {
              id: "session-1",
              appId: "test-app",
              initiatorAgentId: "agent-1",
              status: "closed",
              conversations: { default: "conv-1" },
              createdAt: "2026-04-16T00:00:00.000Z",
            },
          });
        }
        return Effect.succeed({});
      });

      await triggerReconnect();

      expect(app.getSession("session-1")).toBeUndefined();
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SESSION_CLOSED" }),
      );
    });

    it("on reconnect when apps/getSession fails, emits SessionError", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);

      await Effect.runPromise(app.start());
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((method: string) => {
        if (method === "apps/getSession") {
          return Effect.fail(new Error("network gone"));
        }
        return Effect.succeed({});
      });

      await triggerReconnect();

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SESSION_ERROR" }),
      );
      expect(app.getSession("session-1")).toBeDefined();
    });
  });
});
