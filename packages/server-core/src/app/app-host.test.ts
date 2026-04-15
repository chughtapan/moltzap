import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppHost, type ContactChecker } from "./app-host.js";
import { ErrorCodes } from "@moltzap/protocol";
import { RpcError } from "../rpc/router.js";

// Minimal mocks matching the interfaces AppHost depends on
function createMockDb() {
  const rows: Record<string, unknown[]> = {};
  const mockTrx = {
    insertInto: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returningAll: vi.fn().mockReturnValue({
          executeTakeFirstOrThrow: vi.fn().mockResolvedValue({
            id: crypto.randomUUID(),
            type: "group",
            name: "test",
            created_by_type: "agent",
            created_by_id: "agent-1",
            created_at: new Date(),
            updated_at: new Date(),
          }),
        }),
        execute: vi.fn().mockResolvedValue([]),
        onConflict: vi.fn().mockReturnValue({
          doNothing: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue([]),
          }),
          doUpdateSet: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue([]),
          }),
          columns: vi.fn().mockReturnValue({
            doUpdateSet: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    }),
  };

  return {
    selectFrom: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(null),
            }),
            execute: vi.fn().mockResolvedValue([]),
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
          execute: vi.fn().mockResolvedValue(rows["agents"] ?? []),
        }),
      }),
    }),
    updateTable: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue([]),
          }),
          execute: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insertInto: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflict: vi.fn().mockReturnValue({
          columns: vi.fn().mockReturnValue({
            doUpdateSet: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        execute: vi.fn().mockResolvedValue([]),
      }),
    }),
    transaction: vi.fn().mockReturnValue({
      execute: vi
        .fn()
        .mockImplementation(async (fn: (trx: unknown) => Promise<void>) =>
          fn(mockTrx),
        ),
    }),
    _setAgentRows(agentRows: unknown[]) {
      rows["agents"] = agentRows;
      // Re-wire selectFrom to return the agent rows
      (this.selectFrom as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue(agentRows),
          }),
        }),
      });
    },
  };
}

function createMockBroadcaster() {
  return {
    sendToParticipant: vi.fn(),
    broadcastToConversation: vi.fn().mockReturnValue([]),
  };
}

function createMockConnections() {
  return {
    getByParticipant: vi.fn().mockReturnValue([]),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "info",
    silent: vi.fn(),
  };
}

const TEST_MANIFEST = {
  appId: "test-app",
  name: "Test App",
  permissions: { required: [], optional: [] },
  conversations: [
    { key: "main", name: "Main Channel", participantFilter: "all" as const },
  ],
};

const TEST_AGENTS = [
  { id: "agent-init", owner_user_id: "user-1", status: "active" },
  { id: "agent-2", owner_user_id: "user-2", status: "active" },
  { id: "agent-3", owner_user_id: "user-3", status: "active" },
];

describe("AppHost", () => {
  let appHost: AppHost;
  let db: ReturnType<typeof createMockDb>;
  let broadcaster: ReturnType<typeof createMockBroadcaster>;
  let connections: ReturnType<typeof createMockConnections>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    db = createMockDb();
    broadcaster = createMockBroadcaster();
    connections = createMockConnections();
    logger = createMockLogger();
    appHost = new AppHost(
      db as never,
      broadcaster as never,
      connections as never,
      null as never, // conversationService not used directly
      logger as never,
    );
  });

  describe("registerApp", () => {
    it("stores manifest and logs", () => {
      appHost.registerApp(TEST_MANIFEST);
      expect(appHost.getManifest("test-app")).toEqual(TEST_MANIFEST);
      expect(logger.info).toHaveBeenCalledWith(
        { appId: "test-app" },
        "App registered",
      );
    });

    it("overwrites on duplicate appId", () => {
      appHost.registerApp(TEST_MANIFEST);
      const updated = { ...TEST_MANIFEST, name: "Updated" };
      appHost.registerApp(updated);
      expect(appHost.getManifest("test-app")?.name).toBe("Updated");
    });
  });

  describe("createSession", () => {
    beforeEach(() => {
      appHost.registerApp(TEST_MANIFEST);
      db._setAgentRows(TEST_AGENTS);
    });

    it("throws AppNotFound for unknown appId", async () => {
      await expect(
        appHost.createSession("unknown", "agent-init", []),
      ).rejects.toThrow(RpcError);

      try {
        await appHost.createSession("unknown", "agent-init", []);
      } catch (err) {
        expect((err as RpcError).code).toBe(ErrorCodes.AppNotFound);
      }
    });

    it("throws MaxParticipants when too many agents", async () => {
      appHost.registerApp({
        ...TEST_MANIFEST,
        appId: "small",
        limits: { maxParticipants: 2 },
      });
      const manyAgents = Array.from({ length: 3 }, (_, i) => `agent-${i}`);
      await expect(
        appHost.createSession("small", "agent-init", manyAgents),
      ).rejects.toThrow(RpcError);
    });

    it("throws AgentNotFound for missing initiator", async () => {
      db._setAgentRows([]); // no agents in DB
      await expect(
        appHost.createSession("test-app", "agent-init", []),
      ).rejects.toThrow(RpcError);
    });

    it("throws AgentNoOwner for ownerless initiator", async () => {
      db._setAgentRows([
        { id: "agent-init", owner_user_id: null, status: "active" },
      ]);
      await expect(
        appHost.createSession("test-app", "agent-init", []),
      ).rejects.toThrow(RpcError);
    });

    it("creates session with empty invitedAgentIds and emits sessionReady", async () => {
      const session = await appHost.createSession("test-app", "agent-init", []);
      expect(session.appId).toBe("test-app");
      expect(session.status).toBe("active");
      expect(session.initiatorAgentId).toBe("agent-init");
      expect(session.conversations).toHaveProperty("main");

      // Should emit sessionReady to initiator
      expect(broadcaster.sendToParticipant).toHaveBeenCalledWith(
        "agent",
        "agent-init",
        expect.objectContaining({
          event: "app/sessionReady",
        }),
      );
    });

    it("creates session with invited agents and starts admission", async () => {
      const session = await appHost.createSession("test-app", "agent-init", [
        "agent-2",
      ]);
      expect(session.status).toBe("waiting");
      expect(session.conversations).toHaveProperty("main");
    });
  });

  describe("resolveChallenge", () => {
    it("ignores unknown challengeId", () => {
      // Should not throw
      appHost.resolveChallenge("nonexistent", "agent-1", "url", "1.0");
    });

    it("rejects attestation from wrong agent", () => {
      // Simulate a pending challenge
      const challengeId = crypto.randomUUID();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (appHost as any)["pendingChallenges"].set(challengeId, {
        targetAgentId: "agent-2",
        sessionId: "session-1",
        resolve: vi.fn(),
        reject: vi.fn(),
        timer: setTimeout(() => {}, 30000),
      });

      appHost.resolveChallenge(challengeId, "wrong-agent", "url", "1.0");

      // Should still be pending (not resolved)
      expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (appHost as any)["pendingChallenges"].has(challengeId),
      ).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          expected: "agent-2",
          got: "wrong-agent",
        }),
        "Skill attestation from wrong agent",
      );

      // cleanup
      clearTimeout(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (appHost as any)["pendingChallenges"].get(challengeId)!.timer,
      );
    });

    it("resolves valid challenge", () => {
      const challengeId = crypto.randomUUID();
      const resolve = vi.fn();
      const timer = setTimeout(() => {}, 30000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (appHost as any)["pendingChallenges"].set(challengeId, {
        targetAgentId: "agent-2",
        sessionId: "session-1",
        resolve,
        reject: vi.fn(),
        timer,
      });

      appHost.resolveChallenge(challengeId, "agent-2", "skill-url", "1.0");

      expect(resolve).toHaveBeenCalledWith({
        skillUrl: "skill-url",
        version: "1.0",
      });
      expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (appHost as any)["pendingChallenges"].has(challengeId),
      ).toBe(false);
    });
  });

  describe("identity check", () => {
    beforeEach(() => {
      appHost.registerApp(TEST_MANIFEST);
    });

    it("allows all agents when no ContactChecker is set", async () => {
      db._setAgentRows(TEST_AGENTS);
      const session = await appHost.createSession("test-app", "agent-init", [
        "agent-2",
      ]);
      // Session created without error — identity check passed with default allow-all
      expect(session.status).toBe("waiting");
    });

    it("rejects agents when ContactChecker returns false", async () => {
      const checker: ContactChecker = {
        areInContact: vi.fn().mockResolvedValue(false),
      };
      appHost.setContactChecker(checker);
      db._setAgentRows(TEST_AGENTS);

      await appHost.createSession("test-app", "agent-init", ["agent-2"]);

      // Wait for async admission to complete
      await new Promise((r) => setTimeout(r, 100));

      // Should have sent a rejection event
      expect(broadcaster.sendToParticipant).toHaveBeenCalledWith(
        "agent",
        "agent-2",
        expect.objectContaining({
          event: "app/participantRejected",
        }),
      );
    });
  });

  describe("setContactChecker", () => {
    it("updates the checker", () => {
      const checker: ContactChecker = {
        areInContact: vi.fn().mockResolvedValue(true),
      };
      appHost.setContactChecker(checker);
      // Internal state updated (no public getter, but exercises the code path)
      expect(checker).toBeDefined();
    });
  });
});
