import { describe, it, expect, vi, beforeEach } from "vitest";
import { MoltZapApp } from "./app.js";
import { AppError } from "./errors.js";

// Mock MoltZapWsClient. Captures the constructor's onEvent/onReconnect/
// onDisconnect callbacks on the returned instance so tests can simulate
// server-side events and connection lifecycle transitions.
vi.mock("@moltzap/client", () => {
  return {
    MoltZapWsClient: vi
      .fn()
      .mockImplementation(
        (opts: {
          onEvent?: unknown;
          onReconnect?: unknown;
          onDisconnect?: unknown;
        }) => ({
          _onEvent: opts.onEvent,
          _onReconnect: opts.onReconnect,
          _onDisconnect: opts.onDisconnect,
          connect: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
          sendRpc: vi.fn().mockImplementation((method: string) => {
            if (method === "apps/register") {
              return Promise.resolve({ appId: "test-app" });
            }
            if (method === "apps/create") {
              return Promise.resolve({
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
              return Promise.resolve({ ts: new Date().toISOString() });
            }
            if (method === "apps/closeSession") {
              return Promise.resolve({ closed: true });
            }
            if (method === "messages/send") {
              return Promise.resolve({
                message: {
                  id: "msg-1",
                  conversationId: "conv-1",
                  senderId: "agent-1",
                  parts: [{ type: "text", text: "hello" }],
                  createdAt: "2026-04-16T00:00:00.000Z",
                },
              });
            }
            return Promise.resolve({});
          }),
          close: vi.fn(),
          disconnect: vi.fn(),
        }),
      ),
  };
});

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
      const session = await app.start();
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

    it("fires onSessionReady for already-active sessions", async () => {
      const handler = vi.fn();
      app.onSessionReady(handler);

      await app.start();

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 0));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0].id).toBe("session-1");
    });
  });

  describe("stop()", () => {
    it("closes sessions and the client", async () => {
      await app.start();
      await app.stop();

      expect(app.client.sendRpc).toHaveBeenCalledWith("apps/closeSession", {
        sessionId: "session-1",
      });
      expect(app.client.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("session management", () => {
    it("getSession returns the session by ID", async () => {
      await app.start();
      const session = app.getSession("session-1");
      expect(session).toBeDefined();
      expect(session!.id).toBe("session-1");
    });

    it("getSession returns undefined for unknown ID", async () => {
      await app.start();
      expect(app.getSession("unknown")).toBeUndefined();
    });

    it("activeSessions returns active sessions", async () => {
      await app.start();
      expect(app.activeSessions).toHaveLength(1);
    });
  });

  describe("messaging", () => {
    it("send() resolves conversation key and sends", async () => {
      await app.start();
      await app.send("default", [{ type: "text", text: "hello" }]);

      expect(app.client.sendRpc).toHaveBeenCalledWith("messages/send", {
        conversationId: "conv-1",
        parts: [{ type: "text", text: "hello" }],
      });
    });

    it("send() throws ConversationKeyError for unknown key", async () => {
      await app.start();
      await expect(
        app.send("nonexistent", [{ type: "text", text: "hello" }]),
      ).rejects.toThrow("Unknown conversation key");
    });

    it("sendTo() sends by raw conversation ID", async () => {
      await app.start();
      await app.sendTo("conv-1", [{ type: "text", text: "hello" }]);

      expect(app.client.sendRpc).toHaveBeenCalledWith("messages/send", {
        conversationId: "conv-1",
        parts: [{ type: "text", text: "hello" }],
      });
    });

    it("reply() sends replyToId; server resolves the target conversation", async () => {
      await app.start();
      await app.reply("msg-1", [{ type: "text", text: "reply" }]);

      expect(app.client.sendRpc).toHaveBeenCalledWith("messages/send", {
        replyToId: "msg-1",
        parts: [{ type: "text", text: "reply" }],
      });
    });
  });

  describe("sessionReady dedup", () => {
    it("fires handlers once even when apps/create returns active AND app/sessionReady event arrives", async () => {
      const handler = vi.fn();
      app.onSessionReady(handler);

      await app.start();
      await new Promise((r) => setTimeout(r, 0));
      expect(handler).toHaveBeenCalledTimes(1);

      // Simulate duplicate server event for the same session
      const onEvent = (
        app.client as unknown as { _onEvent: (e: unknown) => void }
      )._onEvent;
      onEvent({
        type: "event",
        event: "app/sessionReady",
        data: { sessionId: "session-1", conversations: { default: "conv-1" } },
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("event dispatch", () => {
    const fireEvent = (event: string, data: Record<string, unknown>): void => {
      const onEvent = (
        app.client as unknown as {
          _onEvent: (e: unknown) => void;
        }
      )._onEvent;
      onEvent({ type: "event", event, data });
    };

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

      await app.start();
      fireEvent("messages/received", { message: inboundMessage });
      await new Promise((r) => setTimeout(r, 0));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(inboundMessage);
    });

    it("onMessage catch-all '*' fires for every message", async () => {
      const starHandler = vi.fn();
      app.onMessage("*", starHandler);

      await app.start();
      fireEvent("messages/received", { message: inboundMessage });
      await new Promise((r) => setTimeout(r, 0));

      expect(starHandler).toHaveBeenCalledWith(inboundMessage);
    });

    it("onMessage ignores messages whose conversationId maps to no key (no catch-all)", async () => {
      const handler = vi.fn();
      app.onMessage("default", handler);

      await app.start();
      fireEvent("messages/received", {
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

      await app.start();
      fireEvent("messages/received", { message: inboundMessage });

      // Promise.resolve().catch is async — flush microtasks
      await new Promise((r) => setTimeout(r, 0));

      expect(errorHandler).toHaveBeenCalledTimes(1);
      const err = errorHandler.mock.calls[0]![0] as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe("HANDLER_ERROR");
    });

    it("onParticipantAdmitted fires on app/participantAdmitted", async () => {
      const handler = vi.fn();
      app.onParticipantAdmitted(handler);

      await app.start();
      const event = {
        sessionId: "session-1",
        agentId: "agent-9",
        grantedResources: ["messages"],
      };
      fireEvent("app/participantAdmitted", event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("onParticipantRejected fires on app/participantRejected", async () => {
      const handler = vi.fn();
      app.onParticipantRejected(handler);

      await app.start();
      const event = {
        sessionId: "session-1",
        agentId: "agent-9",
        reason: "identity check failed",
        stage: "identity",
        rejectionCode: "NOT_CONTACT",
      };
      fireEvent("app/participantRejected", event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("app/sessionClosed removes the session and emits SessionClosedError", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);

      await app.start();
      expect(app.getSession("session-1")).toBeDefined();

      fireEvent("app/sessionClosed", { sessionId: "session-1" });

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

      await appWithSkill.start();
      const onEvent = (
        appWithSkill.client as unknown as {
          _onEvent: (e: unknown) => void;
        }
      )._onEvent;
      onEvent({
        type: "event",
        event: "app/skillChallenge",
        data: { challengeId: "chal-1" },
      });

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
      await app.start();
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockClear();

      const onEvent = (
        app.client as unknown as {
          _onEvent: (e: unknown) => void;
        }
      )._onEvent;
      onEvent({
        type: "event",
        event: "app/skillChallenge",
        data: { challengeId: "chal-1" },
      });

      expect(sendRpc).not.toHaveBeenCalledWith(
        "apps/attestSkill",
        expect.anything(),
      );
    });
  });

  describe("start() error branches", () => {
    it("throws AuthError when connect fails", async () => {
      const connect = app.client.connect as ReturnType<typeof vi.fn>;
      connect.mockRejectedValueOnce(new Error("tcp reset"));

      await expect(app.start()).rejects.toMatchObject({
        code: "AUTH_FAILED",
        name: "AuthError",
      });
    });

    it("throws ManifestRegistrationError when apps/register fails", async () => {
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((method: string) => {
        if (method === "apps/register") {
          return Promise.reject(new Error("manifest invalid"));
        }
        return Promise.resolve({});
      });

      await expect(app.start()).rejects.toMatchObject({
        code: "MANIFEST_REJECTED",
        name: "ManifestRegistrationError",
      });
    });

    it("throws SessionError when apps/create fails", async () => {
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      // apps/register succeeds, apps/create rejects
      sendRpc
        .mockImplementationOnce(() => Promise.resolve({ appId: "test-app" }))
        .mockImplementationOnce(() =>
          Promise.reject(new Error("capacity exhausted")),
        );

      await expect(app.start()).rejects.toMatchObject({
        code: "SESSION_ERROR",
        name: "SessionError",
      });
    });
  });

  describe("reconnect recovery", () => {
    const triggerReconnect = async (): Promise<void> => {
      const onReconnect = (
        app.client as unknown as {
          _onReconnect: () => void;
        }
      )._onReconnect;
      onReconnect();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    };

    it("on reconnect with active session, refreshes session via apps/getSession", async () => {
      await app.start();
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((method: string) => {
        if (method === "apps/getSession") {
          return Promise.resolve({
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
        return Promise.resolve({});
      });

      await triggerReconnect();

      expect(sendRpc).toHaveBeenCalledWith("apps/getSession", {
        sessionId: "session-1",
      });
      // Session should now include the new "extra" conversation
      expect(app.getSession("session-1")!.conversations.extra).toBe("conv-2");
    });

    it("on reconnect with closed session, removes it and emits SessionClosedError", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);

      await app.start();
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((method: string) => {
        if (method === "apps/getSession") {
          return Promise.resolve({
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
        return Promise.resolve({});
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

      await app.start();
      const sendRpc = app.client.sendRpc as ReturnType<typeof vi.fn>;
      sendRpc.mockImplementationOnce((method: string) => {
        if (method === "apps/getSession") {
          return Promise.reject(new Error("network gone"));
        }
        return Promise.resolve({});
      });

      await triggerReconnect();

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SESSION_ERROR" }),
      );
      // Session is NOT removed on a transient error — only on status=closed/failed
      expect(app.getSession("session-1")).toBeDefined();
    });
  });
});
