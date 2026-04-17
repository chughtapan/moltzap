/**
 * Race-safety proof for `AppHost.checkPermissions`'s `coalesce` wrap.
 *
 * The coalesce key is `${ownerUserId}:${appId}:${resource}`. N concurrent
 * admission fibers that hit the same key should collapse to a single
 * downstream `PermissionService.requestPermission` invocation — the first
 * caller installs a Deferred via `Ref.modify` (atomic), the rest await it.
 *
 * We build N concurrent `apps/create` calls that all invite the same
 * agent for the same app+resource and plug in a counting
 * `PermissionService` that never completes on its own. All N fibers must
 * land on the same in-flight Deferred; a counter of `requestPermission`
 * invocations should read exactly 1. When we resolve the Deferred, every
 * fiber resumes with the same access and every invited agent is admitted.
 */

import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import type { AppManifest } from "@moltzap/protocol";
import type { Kysely } from "kysely";
import type { Database } from "../../db/database.js";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  getKyselyDb,
  getTestCoreApp,
  trackClient,
} from "./helpers.js";
import { MoltZapWsClient } from "@moltzap/client";
import { registerAgent, stripWsPath } from "@moltzap/client/test";
import type { PermissionService } from "../../app/app-host.js";

let db: Kysely<Database>;

const USER_ALICE = "00000000-0000-4000-a000-000000000101";
const USER_BOB = "00000000-0000-4000-a000-000000000102";

const MANIFEST: AppManifest = {
  appId: "coalesce-race-app",
  name: "Coalesce Race Test App",
  permissions: {
    required: [{ resource: "calendar", access: ["read"] }],
    optional: [],
  },
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

interface OwnedAgent {
  client: MoltZapWsClient;
  agentId: string;
  apiKey: string;
}

function registerWithOwner(
  name: string,
  userId: string,
): Effect.Effect<OwnedAgent, Error> {
  return Effect.gen(function* () {
    const app = getTestCoreApp();
    const baseUrl = `http://localhost:${app.port}`;
    const wsUrl = `ws://localhost:${app.port}/ws`;

    const reg = yield* registerAgent(baseUrl, name);

    yield* Effect.tryPromise(() =>
      db
        .updateTable("agents")
        .set({ owner_user_id: userId })
        .where("id", "=", reg.agentId)
        .execute(),
    );

    const client = new MoltZapWsClient({
      serverUrl: stripWsPath(wsUrl),
      agentKey: reg.apiKey,
    });
    trackClient(client);
    yield* client.connect();

    return { client, agentId: reg.agentId, apiKey: reg.apiKey };
  });
}

beforeAll(async () => {
  await startTestServer();
  db = getKyselyDb();
  getTestCoreApp().registerApp(MANIFEST);
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  getTestCoreApp().registerApp(MANIFEST);
});

describe("Scenario 23: coalesce race on permission requests", () => {
  it.live(
    "N concurrent admissions for the same user+app+resource collapse to 1 requestPermission call",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerWithOwner("race-alice", USER_ALICE);
        const bob = yield* registerWithOwner("race-bob", USER_BOB);

        // Controlled permission service. Every caller awaits the same
        // Deferred; the RUN counter lives inside the Effect so it only
        // increments when the Effect actually executes (not when each
        // admission fiber constructs its Effect). The coalesce layer runs
        // the Effect exactly once for the winning owner; a broken coalesce
        // would let every fiber's Effect run.
        const gate = yield* Deferred.make<string[], never>();
        let runCount = 0;

        const countingSvc: PermissionService = {
          requestPermission: () =>
            Effect.suspend(() => {
              runCount++;
              return Deferred.await(gate);
            }),
        };
        getTestCoreApp().setPermissionService(countingSvc);

        // Fire N concurrent apps/create calls. Each invites bob for the same
        // calendar resource — the coalesce key is
        // `${USER_BOB}:coalesce-race-app:calendar`, identical across all N.
        const N = 5;
        const createEffects = Array.from({ length: N }, () =>
          alice.client.sendRpc("apps/create", {
            appId: "coalesce-race-app",
            invitedAgentIds: [bob.agentId],
          }),
        );

        // Wait for every session row to be created + admitAgentsAsync to
        // launch. We poll `app_sessions` rather than sleeping a fixed amount
        // so fast local machines and slow CI finish in the same shape.
        const waitSessionsAt = async (expected: number) => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const rows = await db
              .selectFrom("app_sessions")
              .select("id")
              .where("app_id", "=", "coalesce-race-app")
              .execute();
            if (rows.length >= expected) return;
            await new Promise((r) => setTimeout(r, 20));
          }
          throw new Error(`Timed out waiting for ${expected} sessions`);
        };

        yield* Effect.all(createEffects, { concurrency: "unbounded" });
        yield* Effect.promise(() => waitSessionsAt(N));

        // Let the N admission fibers race through their concurrent checks
        // and settle on the single coalesce Deferred before we assert.
        // 150ms is generous on this harness — every check prior to
        // checkPermissions is a synchronous Kysely query on PGlite.
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 150)));

        // The load-bearing assertion: exactly one downstream run.
        expect(runCount).toBe(1);

        // Unblock the coalesced request so the N fibers resume and admit bob.
        yield* Deferred.succeed(gate, ["read"]);

        // Wait for all sessions to settle to `active`. The grant is stored
        // once (by the owner fiber), every other fiber reads the cached row.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const rows = yield* Effect.tryPromise(() =>
            db
              .selectFrom("app_sessions")
              .select("status")
              .where("app_id", "=", "coalesce-race-app")
              .execute(),
          );
          if (rows.length === N && rows.every((r) => r.status === "active"))
            break;
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)));
        }

        const finalRows = yield* Effect.tryPromise(() =>
          db
            .selectFrom("app_sessions")
            .select("status")
            .where("app_id", "=", "coalesce-race-app")
            .execute(),
        );
        expect(finalRows).toHaveLength(N);
        expect(finalRows.every((r) => r.status === "active")).toBe(true);

        // The grant row must be written exactly once (the owner fiber writes
        // it; the others share the Deferred result without touching the DB).
        const grants = yield* Effect.tryPromise(() =>
          db
            .selectFrom("app_permission_grants")
            .selectAll()
            .where("user_id", "=", USER_BOB)
            .where("app_id", "=", "coalesce-race-app")
            .execute(),
        );
        expect(grants).toHaveLength(1);
        expect(grants[0]!.resource).toBe("calendar");
        expect(grants[0]!.access).toEqual(["read"]);

        yield* alice.client.close();
        yield* bob.client.close();
      }),
  );
});
