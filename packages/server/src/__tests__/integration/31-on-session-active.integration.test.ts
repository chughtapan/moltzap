// ─────────────────────────────────────────────────────────────────────
// on_session_active integration coverage (issue #84).
//
// Fires once per session from `admitAgentsAsync` immediately after the
// DB row transitions to `status = "active"` and BEFORE `app/sessionReady`
// is broadcast to the initiator. Fail-open semantics match on_join /
// on_close: timeout or handler throw logs + emits `app/hookTimeout`,
// admission still completes, `app/sessionReady` still fires.
//
// Timeouts here are real wall-clock — TestClock does not apply to the
// server's fibers (see the header of 30-app-hooks.integration.test.ts).
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";
import type { CoreApp } from "../../app/types.js";
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
  opts?: { onSessionActiveTimeoutMs?: number; onSessionActiveWebhook?: string },
) {
  app.registerApp({
    appId,
    name: `Test App ${appId}`,
    permissions: { required: [], optional: [] },
    conversations: [
      { key: "main", name: "Main Channel", participantFilter: "all" },
    ],
    hooks: {
      before_message_delivery: { timeout_ms: 5000 },
      on_join: {},
      on_session_active: {
        ...(opts?.onSessionActiveWebhook
          ? { webhook: opts.onSessionActiveWebhook }
          : {}),
        ...(opts?.onSessionActiveTimeoutMs !== undefined
          ? { timeout_ms: opts.onSessionActiveTimeoutMs }
          : {}),
      },
    },
  });
}

interface HookServerRecord {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface HookServer {
  url: string;
  requests: HookServerRecord[];
  close: () => Promise<void>;
}

async function startHookServer(
  handler: (
    req: HookServerRecord,
  ) =>
    | { status?: number; body?: unknown; delayMs?: number }
    | Promise<{ status?: number; body?: unknown; delayMs?: number }>,
): Promise<HookServer> {
  const requests: HookServerRecord[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const record: HookServerRecord = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: { ...req.headers },
          body: Buffer.concat(chunks).toString("utf-8"),
        };
        requests.push(record);
        try {
          const response = await handler(record);
          if (response.delayMs) {
            await new Promise((r) => setTimeout(r, response.delayMs));
          }
          const status = response.status ?? 200;
          if (response.body === undefined || response.body === null) {
            res.writeHead(status);
            res.end();
          } else {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response.body));
          }
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("Scenario 31b: on_session_active hook", () => {
  it.live("fires once after the last admission with expected context", () =>
    Effect.gen(function* () {
      const initiator = yield* registerAppAgent("osa-init");
      const inviteeA = yield* registerAppAgent("osa-invitee-a");
      const inviteeB = yield* registerAppAgent("osa-invitee-b");

      const calls: Array<{
        sessionId: string;
        appId: string;
        conversations: Record<string, string>;
        admittedAgentIds: string[];
      }> = [];

      registerTestApp(coreApp, "osa-fire-once");

      coreApp.onSessionActive("osa-fire-once", (ctx) => {
        calls.push({
          sessionId: ctx.sessionId,
          appId: ctx.appId,
          conversations: ctx.conversations,
          admittedAgentIds: [...ctx.admittedAgentIds],
        });
      });

      const session = (yield* initiator.client.rpc("apps/create", {
        appId: "osa-fire-once",
        invitedAgentIds: [inviteeA.agentId, inviteeB.agentId],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      yield* initiator.client.waitForEvent("app/sessionReady", 5000);
      // admitAgentsAsync runs on a daemon fiber; give it a beat to fire
      // the hook and update the session row even after sessionReady
      // (the hook runs synchronously before broadcast, but defensive).
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 100)));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.sessionId).toBe(session.session.id);
      expect(calls[0]!.appId).toBe("osa-fire-once");
      expect(calls[0]!.conversations).toHaveProperty("main");
      expect([...calls[0]!.admittedAgentIds].sort()).toEqual(
        [inviteeA.agentId, inviteeB.agentId].sort(),
      );
    }),
  );

  it.live("fires BEFORE app/sessionReady reaches the initiator", () =>
    Effect.gen(function* () {
      const initiator = yield* registerAppAgent("osa-order-init");
      const invitee = yield* registerAppAgent("osa-order-invitee");

      let hookFinishedAt: number | null = null;
      registerTestApp(coreApp, "osa-order", { onSessionActiveTimeoutMs: 5000 });

      // Block inside the hook long enough that the event handler on the
      // client side cannot observe sessionReady before the hook resolves.
      // Ordering claim: sessionReady is broadcast AFTER the hook returns.
      coreApp.onSessionActive("osa-order", async () => {
        await new Promise((r) => setTimeout(r, 300));
        hookFinishedAt = Date.now();
      });

      yield* initiator.client.rpc("apps/create", {
        appId: "osa-order",
        invitedAgentIds: [invitee.agentId],
      });

      const ready = yield* initiator.client.waitForEvent(
        "app/sessionReady",
        5000,
      );
      const readyAt = Date.now();
      // Sanity: event carried the sessionId the initiator just created.
      expect((ready.data as { sessionId: string }).sessionId).toBeTruthy();
      expect(hookFinishedAt).not.toBeNull();
      expect(hookFinishedAt!).toBeLessThanOrEqual(readyAt);
    }),
  );

  it.live("timeout emits app/hookTimeout and admission still completes", () =>
    Effect.gen(function* () {
      const initiator = yield* registerAppAgent("osa-timeout-init");
      const invitee = yield* registerAppAgent("osa-timeout-invitee");

      registerTestApp(coreApp, "osa-timeout-app", {
        onSessionActiveTimeoutMs: 150,
      });

      coreApp.onSessionActive("osa-timeout-app", async () => {
        await new Promise((r) => setTimeout(r, 600));
      });

      const session = (yield* initiator.client.rpc("apps/create", {
        appId: "osa-timeout-app",
        invitedAgentIds: [invitee.agentId],
      })) as { session: { id: string } };

      const timeoutEvent = yield* initiator.client.waitForEvent(
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
      expect(data.appId).toBe("osa-timeout-app");
      expect(data.hookName).toBe("on_session_active");
      expect(data.timeoutMs).toBe(150);

      // Fail-open: sessionReady still fires and session row reaches active.
      yield* initiator.client.waitForEvent("app/sessionReady", 3000);
      const db = getKyselyDb();
      const sessionRow = yield* Effect.tryPromise(() =>
        db
          .selectFrom("app_sessions")
          .select("status")
          .where("id", "=", session.session.id)
          .executeTakeFirstOrThrow(),
      );
      expect(sessionRow.status).toBe("active");
    }),
  );

  it.live("handler throw is fail-open: admission still completes", () =>
    Effect.gen(function* () {
      const initiator = yield* registerAppAgent("osa-throw-init");
      const invitee = yield* registerAppAgent("osa-throw-invitee");

      registerTestApp(coreApp, "osa-throw-app");

      coreApp.onSessionActive("osa-throw-app", () => {
        throw new Error("boom from on_session_active");
      });

      const session = (yield* initiator.client.rpc("apps/create", {
        appId: "osa-throw-app",
        invitedAgentIds: [invitee.agentId],
      })) as { session: { id: string } };

      yield* initiator.client.waitForEvent("app/sessionReady", 3000);

      const db = getKyselyDb();
      const sessionRow = yield* Effect.tryPromise(() =>
        db
          .selectFrom("app_sessions")
          .select("status")
          .where("id", "=", session.session.id)
          .executeTakeFirstOrThrow(),
      );
      expect(sessionRow.status).toBe("active");
    }),
  );

  it.live("webhook: POSTs hook context and admission proceeds", () =>
    Effect.gen(function* () {
      const initiator = yield* registerAppAgent("osa-webhook-init");
      const invitee = yield* registerAppAgent("osa-webhook-invitee");

      const hook = yield* Effect.promise(() =>
        startHookServer(() => ({ status: 200, body: null })),
      );

      try {
        registerTestApp(coreApp, "osa-webhook-app", {
          onSessionActiveWebhook: hook.url + "/on-session-active",
        });

        const session = (yield* initiator.client.rpc("apps/create", {
          appId: "osa-webhook-app",
          invitedAgentIds: [invitee.agentId],
        })) as { session: { id: string } };

        yield* initiator.client.waitForEvent("app/sessionReady", 5000);

        expect(hook.requests).toHaveLength(1);
        const req = hook.requests[0]!;
        expect(req.method).toBe("POST");
        expect(req.path).toBe("/on-session-active");
        expect(req.headers["x-moltzap-event"]).toBe("app.on_session_active");

        const payload = JSON.parse(req.body) as {
          sessionId: string;
          appId: string;
          conversations: Record<string, string>;
          admittedAgentIds: string[];
        };
        expect(payload.sessionId).toBe(session.session.id);
        expect(payload.appId).toBe("osa-webhook-app");
        expect(payload.conversations).toHaveProperty("main");
        expect(payload.admittedAgentIds).toEqual([invitee.agentId]);
      } finally {
        yield* Effect.promise(() => hook.close());
      }
    }),
  );
});
