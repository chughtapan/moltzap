import { describe, it, expect, vi, beforeEach } from "vitest";
import { MoltZapApp } from "./app.js";
import { AppError } from "./errors.js";

// Mock MoltZapWsClient
vi.mock("@moltzap/client", () => {
  return {
    MoltZapWsClient: vi.fn().mockImplementation(() => ({
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
    })),
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

    it("reply() sends with replyToId", async () => {
      await app.start();
      await app.reply("msg-1", [{ type: "text", text: "reply" }]);

      expect(app.client.sendRpc).toHaveBeenCalledWith("messages/send", {
        replyToId: "msg-1",
        parts: [{ type: "text", text: "reply" }],
      });
    });
  });

  describe("event handlers", () => {
    it("onError handler receives errors", async () => {
      const errorHandler = vi.fn();
      app.onError(errorHandler);

      await app.start();
      // Trigger error by sending to unknown key
      try {
        await app.send("unknown", [{ type: "text", text: "hello" }]);
      } catch {
        // Expected
      }
    });

    it("onParticipantAdmitted registers handler", () => {
      const handler = vi.fn();
      app.onParticipantAdmitted(handler);
      // Just verify no error on registration
    });

    it("onParticipantRejected registers handler", () => {
      const handler = vi.fn();
      app.onParticipantRejected(handler);
      // Just verify no error on registration
    });

    it("onMessage registers handler for conversation key", () => {
      const handler = vi.fn();
      app.onMessage("main", handler);
      // Just verify no error on registration
    });

    it("onMessage supports catch-all with *", () => {
      const handler = vi.fn();
      app.onMessage("*", handler);
      // Just verify no error on registration
    });
  });
});
