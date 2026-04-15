import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AppHost,
  DefaultPermissionHandler,
  PermissionDeniedError,
  PermissionTimeoutError,
  type ContactChecker,
  type PermissionHandler,
} from "./app-host.js";
import { ErrorCodes } from "@moltzap/protocol";
import { RpcError } from "../rpc/router.js";

// ── Mock helpers ─────────────────────────────────────────────────────

function createMockDb() {
  let agentRows: unknown[] = [];
  let grantRow: { access: string[] } | null = null;
  let grantRows: unknown[] = [];

  const mockTrx = {
    insertInto: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returningAll: vi.fn().mockReturnValue({
          executeTakeFirstOrThrow: vi.fn().mockResolvedValue({
            id: crypto.randomUUID(),
            type: "group",
            name: "test",
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

  // Build the agents chain: selectFrom("agents").select([...]).where("id","in",...).execute()
  function agentsChain() {
    return {
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: vi.fn().mockImplementation(() => Promise.resolve(agentRows)),
        }),
      }),
    };
  }

  // Build the grants chain for findGrant:
  //   selectFrom("app_permission_grants").select("access").where(...).where(...).where(...).executeTakeFirst()
  // and for listGrants:
  //   selectFrom("app_permission_grants").select([...]).where(...).where(...).execute()
  function grantsChain() {
    return {
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi
                .fn()
                .mockImplementation(() => Promise.resolve(grantRow)),
            }),
            execute: vi
              .fn()
              .mockImplementation(() => Promise.resolve(grantRows)),
          }),
          execute: vi.fn().mockImplementation(() => Promise.resolve(grantRows)),
        }),
      }),
    };
  }

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "agents") return agentsChain();
      if (table === "app_permission_grants") return grantsChain();
      // Fallback: deep mock
      return agentsChain();
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
    deleteFrom: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({ numDeletedRows: 0n }),
          }),
        }),
      }),
    }),
    transaction: vi.fn().mockReturnValue({
      execute: vi
        .fn()
        .mockImplementation(async (fn: (trx: unknown) => Promise<void>) =>
          fn(mockTrx),
        ),
    }),
    _setAgentRows(rows: unknown[]) {
      agentRows = rows;
    },
    _setGrantRow(row: { access: string[] } | null) {
      grantRow = row;
    },
    _setGrantRows(rows: unknown[]) {
      grantRows = rows;
    },
  };

  return db;
}

function createMockBroadcaster() {
  return {
    sendToAgent: vi.fn(),
    broadcastToConversation: vi.fn().mockReturnValue([]),
  };
}

function createMockConnections() {
  return {
    getByAgent: vi.fn().mockReturnValue([]),
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

function getChallenges(host: AppHost): Map<string, Record<string, unknown>> {
  return Reflect.get(host, "pendingChallenges") as Map<
    string,
    Record<string, unknown>
  >;
}

/** Wait for async admission (admitAgentsAsync fires-and-forgets). */
function waitForAdmission(ms = 150) {
  return new Promise((r) => setTimeout(r, ms));
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

// ── Tests ────────────────────────────────────────────────────────────

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
      null as never,
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
      db._setAgentRows([]);
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

      expect(broadcaster.sendToAgent).toHaveBeenCalledWith(
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
      appHost.resolveChallenge("nonexistent", "agent-1", "url", "1.0");
    });

    it("rejects attestation from wrong agent", () => {
      const challengeId = crypto.randomUUID();
      getChallenges(appHost).set(challengeId, {
        targetAgentId: "agent-2",
        sessionId: "session-1",
        resolve: vi.fn(),
        reject: vi.fn(),
        timer: setTimeout(() => {}, 30000),
      });

      appHost.resolveChallenge(challengeId, "wrong-agent", "url", "1.0");

      expect(getChallenges(appHost).has(challengeId)).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          expected: "agent-2",
          got: "wrong-agent",
        }),
        "Skill attestation from wrong agent",
      );

      appHost.destroy();
    });

    it("resolves valid challenge", () => {
      const challengeId = crypto.randomUUID();
      const resolve = vi.fn();
      const timer = setTimeout(() => {}, 30000);

      getChallenges(appHost).set(challengeId, {
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
      expect(getChallenges(appHost).has(challengeId)).toBe(false);
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
      expect(session.status).toBe("waiting");
    });

    it("rejects agents when ContactChecker returns false", async () => {
      const checker: ContactChecker = {
        areInContact: vi.fn().mockResolvedValue(false),
      };
      appHost.setContactChecker(checker);
      db._setAgentRows(TEST_AGENTS);

      await appHost.createSession("test-app", "agent-init", ["agent-2"]);
      await waitForAdmission();

      expect(broadcaster.sendToAgent).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          event: "app/participantRejected",
        }),
      );
    });
  });

  // setContactChecker and setPermissionHandler are exercised by the admission tests below

  describe("PermissionHandler integration", () => {
    const PERM_MANIFEST = {
      ...TEST_MANIFEST,
      appId: "perm-app",
      permissions: {
        required: [{ resource: "calendar", access: ["read", "write"] }],
        optional: [],
      },
    };

    beforeEach(() => {
      appHost.registerApp(PERM_MANIFEST);
      db._setAgentRows(TEST_AGENTS);
    });

    it("calls handler.requestPermission during admission", async () => {
      const handler: PermissionHandler = {
        requestPermission: vi.fn().mockResolvedValue(["read", "write"]),
      };
      appHost.setPermissionHandler(handler);

      await appHost.createSession("perm-app", "agent-init", ["agent-2"]);
      await waitForAdmission();

      expect(handler.requestPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-2",
          agentId: "agent-2",
          appId: "perm-app",
          resource: "calendar",
          access: ["read", "write"],
        }),
      );
    });

    it.each([
      {
        scenario: "no handler configured",
        handler: undefined,
        expectedCode: "no_handler",
      },
      {
        scenario: "handler returns insufficient access",
        handler: { requestPermission: vi.fn().mockResolvedValue(["read"]) },
        expectedCode: "permission_denied",
      },
      {
        scenario: "handler throws PermissionTimeoutError",
        handler: {
          requestPermission: vi
            .fn()
            .mockRejectedValue(new PermissionTimeoutError("calendar")),
        },
        expectedCode: "permission_timeout",
      },
      {
        scenario: "handler throws PermissionDeniedError",
        handler: {
          requestPermission: vi
            .fn()
            .mockRejectedValue(new PermissionDeniedError("calendar")),
        },
        expectedCode: "permission_denied",
      },
      {
        scenario: "handler throws unknown error",
        handler: {
          requestPermission: vi
            .fn()
            .mockRejectedValue(new Error("network error")),
        },
        expectedCode: "permission_denied",
      },
    ])(
      "rejects with '$expectedCode' when $scenario",
      async ({ handler, expectedCode }) => {
        if (handler) appHost.setPermissionHandler(handler);

        await appHost.createSession("perm-app", "agent-init", ["agent-2"]);
        await waitForAdmission();

        expect(broadcaster.sendToAgent).toHaveBeenCalledWith(
          "agent-2",
          expect.objectContaining({
            event: "app/participantRejected",
            data: expect.objectContaining({
              rejectionCode: expectedCode,
              stage: "permission",
            }),
          }),
        );
      },
    );

    it("logs when requesting permission from handler", async () => {
      const handler: PermissionHandler = {
        requestPermission: vi.fn().mockResolvedValue(["read", "write"]),
      };
      appHost.setPermissionHandler(handler);

      await appHost.createSession("perm-app", "agent-init", ["agent-2"]);
      await waitForAdmission();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "calendar",
          agentId: "agent-2",
        }),
        "Requesting permission from handler",
      );
    });

    it("logs handler response", async () => {
      const handler: PermissionHandler = {
        requestPermission: vi.fn().mockResolvedValue(["read", "write"]),
      };
      appHost.setPermissionHandler(handler);

      await appHost.createSession("perm-app", "agent-init", ["agent-2"]);
      await waitForAdmission();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "calendar",
          access: ["read", "write"],
        }),
        "Permission handler responded",
      );
    });

    it("skips handler when existing grant covers required access", async () => {
      db._setGrantRow({ access: ["read", "write"] });

      const handler: PermissionHandler = {
        requestPermission: vi.fn().mockResolvedValue(["read", "write"]),
      };
      appHost.setPermissionHandler(handler);

      await appHost.createSession("perm-app", "agent-init", ["agent-2"]);
      await waitForAdmission();

      expect(handler.requestPermission).not.toHaveBeenCalled();
    });
  });

  describe("permission prompt coalescing", () => {
    it("reuses in-flight promise for same userId+appId+resource", async () => {
      const PERM_MANIFEST_COAL = {
        ...TEST_MANIFEST,
        appId: "coal-app",
        permissions: {
          required: [{ resource: "files", access: ["read"] }],
          optional: [],
        },
      };
      appHost.registerApp(PERM_MANIFEST_COAL);

      // Two agents with the same owner
      const agents = [
        { id: "agent-init", owner_user_id: "user-1", status: "active" },
        { id: "agent-A", owner_user_id: "user-shared", status: "active" },
        { id: "agent-B", owner_user_id: "user-shared", status: "active" },
      ];
      db._setAgentRows(agents);

      let resolveFirst!: (v: string[]) => void;
      let callCount = 0;
      const handler: PermissionHandler = {
        requestPermission: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First call: return a controllable promise
            return new Promise<string[]>((resolve) => {
              resolveFirst = resolve;
            });
          }
          // Subsequent calls: resolve immediately
          return Promise.resolve(["read"]);
        }),
      };
      appHost.setPermissionHandler(handler);

      await appHost.createSession("coal-app", "agent-init", [
        "agent-A",
        "agent-B",
      ]);

      // Give async admission a tick to start both agents
      await new Promise((r) => setTimeout(r, 50));

      // Resolve the shared promise
      resolveFirst(["read"]);

      await waitForAdmission(200);

      // Both agents share owner "user-shared" + appId "coal-app" + resource "files".
      // The handler should have been called only once (coalesced).
      expect(callCount).toBe(1);
    });
  });

  describe("findGrant set-containment", () => {
    it("does not use existing grant when stored access is insufficient", async () => {
      // Grant has ["read"] but required is ["read", "write"]
      db._setGrantRow({ access: ["read"] });

      const PERM_MANIFEST_SET = {
        ...TEST_MANIFEST,
        appId: "set-app",
        permissions: {
          required: [{ resource: "docs", access: ["read", "write"] }],
          optional: [],
        },
      };
      appHost.registerApp(PERM_MANIFEST_SET);
      db._setAgentRows(TEST_AGENTS);

      const handler: PermissionHandler = {
        requestPermission: vi.fn().mockResolvedValue(["read", "write"]),
      };
      appHost.setPermissionHandler(handler);

      await appHost.createSession("set-app", "agent-init", ["agent-2"]);
      await waitForAdmission();

      expect(handler.requestPermission).toHaveBeenCalled();
    });

    it("uses existing grant when stored access covers all required access", async () => {
      // Grant has ["read", "write", "admin"] which covers ["read", "write"]
      db._setGrantRow({ access: ["read", "write", "admin"] });

      const PERM_MANIFEST_SET = {
        ...TEST_MANIFEST,
        appId: "set-app2",
        permissions: {
          required: [{ resource: "docs", access: ["read", "write"] }],
          optional: [],
        },
      };
      appHost.registerApp(PERM_MANIFEST_SET);
      db._setAgentRows(TEST_AGENTS);

      const handler: PermissionHandler = {
        requestPermission: vi.fn(),
      };
      appHost.setPermissionHandler(handler);

      await appHost.createSession("set-app2", "agent-init", ["agent-2"]);
      await waitForAdmission();

      expect(handler.requestPermission).not.toHaveBeenCalled();
    });
  });

  describe("listGrants", () => {
    it("returns empty array when no grants exist", async () => {
      db._setGrantRows([]);
      const result = await appHost.listGrants("user-1");
      expect(result).toEqual([]);
    });

    it("returns mapped grant rows", async () => {
      db._setGrantRows([
        {
          app_id: "app-1",
          resource: "calendar",
          access: ["read"],
          granted_at: "2025-01-01T00:00:00.000Z",
        },
      ]);
      const result = await appHost.listGrants("user-1");
      expect(result).toEqual([
        {
          appId: "app-1",
          resource: "calendar",
          access: ["read"],
          grantedAt: expect.any(String),
        },
      ]);
    });

    it("calls selectFrom with app_permission_grants", async () => {
      db._setGrantRows([]);
      await appHost.listGrants("user-1", "specific-app");
      expect(db.selectFrom).toHaveBeenCalledWith("app_permission_grants");
    });
  });

  describe("revokeGrant", () => {
    it("calls deleteFrom on app_permission_grants", async () => {
      await appHost.revokeGrant("user-1", "app-1", "calendar");
      expect(db.deleteFrom).toHaveBeenCalledWith("app_permission_grants");
    });
  });

  describe("destroy", () => {
    it("clears pending challenges", () => {
      const challengeId = crypto.randomUUID();
      getChallenges(appHost).set(challengeId, {
        targetAgentId: "agent-2",
        sessionId: "session-1",
        resolve: vi.fn(),
        reject: vi.fn(),
        timer: setTimeout(() => {}, 30000),
      });

      appHost.destroy();
      expect(getChallenges(appHost).size).toBe(0);
    });
  });
});

describe("DefaultPermissionHandler", () => {
  let handler: DefaultPermissionHandler;
  let broadcaster: ReturnType<typeof createMockBroadcaster>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    broadcaster = createMockBroadcaster();
    logger = createMockLogger();
    handler = new DefaultPermissionHandler(
      broadcaster as never,
      logger as never,
    );
  });

  describe("requestPermission", () => {
    it("sends permissions/required event to the agent", async () => {
      const promise = handler.requestPermission({
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "session-1",
        appId: "app-1",
        resource: "calendar",
        access: ["read"],
        timeoutMs: 5000,
      });

      handler.resolvePermission("user-1", "session-1", "agent-1", "calendar", [
        "read",
      ]);
      await promise;

      expect(broadcaster.sendToAgent).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({
          event: "permissions/required",
          data: expect.objectContaining({
            sessionId: "session-1",
            appId: "app-1",
            resource: "calendar",
            access: ["read"],
            targetUserId: "user-1",
          }),
        }),
      );
    });

    it("resolves with granted access", async () => {
      const promise = handler.requestPermission({
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "session-1",
        appId: "app-1",
        resource: "calendar",
        access: ["read"],
        timeoutMs: 5000,
      });

      handler.resolvePermission("user-1", "session-1", "agent-1", "calendar", [
        "read",
        "write",
      ]);

      const result = await promise;
      expect(result).toEqual(["read", "write"]);
    });

    it("rejects with PermissionTimeoutError on timeout", async () => {
      vi.useFakeTimers();

      const promise = handler.requestPermission({
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "session-1",
        appId: "app-1",
        resource: "calendar",
        access: ["read"],
        timeoutMs: 1000,
      });

      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toThrow(PermissionTimeoutError);
      await expect(promise).rejects.toThrow(
        "Permission timeout for resource: calendar",
      );

      vi.useRealTimers();
    });
  });

  describe("resolvePermission", () => {
    it("ignores unknown permission key", () => {
      handler.resolvePermission("user-1", "session-1", "agent-1", "unknown", [
        "read",
      ]);
    });

    it("rejects grant from wrong user", async () => {
      const promise = handler.requestPermission({
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "session-1",
        appId: "app-1",
        resource: "calendar",
        access: ["read"],
        timeoutMs: 5000,
      });

      handler.resolvePermission(
        "wrong-user",
        "session-1",
        "agent-1",
        "calendar",
        ["read"],
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          expected: "user-1",
          got: "wrong-user",
        }),
        "Permission grant from wrong user",
      );

      // Resolve correctly to avoid hanging
      handler.resolvePermission("user-1", "session-1", "agent-1", "calendar", [
        "read",
      ]);
      await promise;
    });
  });

  describe("destroy", () => {
    it("rejects pending promises and clears map", async () => {
      const promise = handler.requestPermission({
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "session-1",
        appId: "app-1",
        resource: "calendar",
        access: ["read"],
        timeoutMs: 60000,
      });

      handler.destroy();

      await expect(promise).rejects.toThrow(PermissionDeniedError);

      const pendingMap = Reflect.get(handler, "pendingPermissions") as Map<
        string,
        unknown
      >;
      expect(pendingMap.size).toBe(0);
    });
  });
});

describe("PermissionDeniedError", () => {
  it("has correct name and message", () => {
    const err = new PermissionDeniedError("calendar");
    expect(err.name).toBe("PermissionDeniedError");
    expect(err.message).toBe("Permission denied for resource: calendar");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("PermissionTimeoutError", () => {
  it("has correct name and message", () => {
    const err = new PermissionTimeoutError("files");
    expect(err.name).toBe("PermissionTimeoutError");
    expect(err.message).toBe("Permission timeout for resource: files");
    expect(err).toBeInstanceOf(Error);
  });
});
