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

import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";
import type { CoreApp } from "../../app/types.js";
import type { ConnectedAgent } from "../../test-utils/helpers.js";

import {
  AppsCreate,
  AppSessionReadyNotificationDefinition,
  AppHookTimeoutNotificationDefinition,
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
  opts?: { onSessionActiveTimeoutMs?: number },
) {
  app.registerApp({
    appId,
    name: `Test App ${appId}`,
    conversations: [
      { key: "main", name: "Main Channel", participantFilter: "all" },
    ],
    hooks: {
      before_message_delivery: { timeout_ms: 5000 },
      on_join: {},
      on_session_active:
        opts?.onSessionActiveTimeoutMs !== undefined
          ? { timeout_ms: opts.onSessionActiveTimeoutMs }
          : {},
    },
  });
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

      const session = (yield* initiator.client.sendRpc(AppsCreate, {
        appId: "osa-fire-once",
        invitedAgentIds: [inviteeA.agentId, inviteeB.agentId],
      })) as {
        session: { id: string; conversations: Record<string, string> };
      };

      yield* initiator.client.waitForNotification(
        AppSessionReadyNotificationDefinition,
        5000,
      );
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

      yield* initiator.client.sendRpc(AppsCreate, {
        appId: "osa-order",
        invitedAgentIds: [invitee.agentId],
      });

      const ready = yield* initiator.client.waitForNotification(
        AppSessionReadyNotificationDefinition,
        5000,
      );
      const readyAt = Date.now();
      // Sanity: event carried the sessionId the initiator just created.
      expect((ready.params as { sessionId: string }).sessionId).toBeTruthy();
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

      const session = (yield* initiator.client.sendRpc(AppsCreate, {
        appId: "osa-timeout-app",
        invitedAgentIds: [invitee.agentId],
      })) as { session: { id: string } };

      const timeoutEvent = yield* initiator.client.waitForNotification(
        AppHookTimeoutNotificationDefinition,
        3000,
      );
      const data = timeoutEvent.params as {
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
      yield* initiator.client.waitForNotification(
        AppSessionReadyNotificationDefinition,
        3000,
      );
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

      const session = (yield* initiator.client.sendRpc(AppsCreate, {
        appId: "osa-throw-app",
        invitedAgentIds: [invitee.agentId],
      })) as { session: { id: string } };

      yield* initiator.client.waitForNotification(
        AppSessionReadyNotificationDefinition,
        3000,
      );

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
});
