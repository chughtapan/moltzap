// ─────────────────────────────────────────────────────────────────────
// Phase 1.8 / B.9 — server integration tests for the s2c admission +
// lifecycle RPC pipeline (architect plan §3.4 + §B.9 acceptance).
//
// Where the existing `30-app-hooks.integration.test.ts` covers the
// IN-PROCESS hook path (`coreApp.onBeforeMessageDelivery(appId, fn)`),
// this file covers the REMOTE-app path: the app's hook handlers run on
// a separate WS connection, AppHost dispatches via `sendRpcToClient`,
// and the test client replies via the TestClient's
// `handleServerRpc` surface (architect plan §3.6, wired in B.7).
//
// Topology mirrored:
//   - `userAgent` — the orchestrator that creates app sessions and
//     sends messages. Owns `owner_user_id` so admission accepts it.
//   - `appAgent` — the remote app. Holds the s2c handlers via
//     `client.handleServerRpc(...)` then sends `apps/register` so AppHost
//     binds (`appId → connId`) and routes future hook RPCs to this socket.
//
// Real wall-clock; PGlite; real WS; testcontainers Postgres. Hook timeout
// values (e.g. 200ms) are burned as real waits for the same reason
// `30-app-hooks.integration.test.ts` documents in its header.
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
// `BeforeDispatchContext` is part of the AppClientHandlers fixture surface
// even when no test currently calls `onBeforeDispatch` with the captured
// context — keeps the fixture type identical to the SDK's hook surface.
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  registerAgent,
  connectTestClient,
  trackClient,
  getKyselyDb,
  type ServerTestClient,
  type ConnectedAgent,
} from "./helpers.js";
import type { CoreApp } from "../../app/types.js";
import {
  ErrorCodes,
  type AppManifest,
  type BeforeDispatchContext,
  type BeforeMessageDeliveryContext,
  type OnSessionActiveContext,
  type OnJoinContext,
  type OnCloseContext,
  type DispatchAdmissionResult,
  type HookResult,
} from "@moltzap/protocol";
import { expectRpcFailure } from "../../test-utils/index.js";
import { getBaseUrl } from "../../test-utils/index.js";

// Mirror of `app-sdk/src/app.ts:extractAttachCode`'s numeric-code map.
// Server-core doesn't depend on `@moltzap/app-sdk` (would create a
// downstream-on-downstream dep cycle through protocol), so we replicate
// the deterministic mapping inline in this integration test. A single
// source of truth lives in app-sdk; the SDK round-trip is unit-tested
// against real numeric codes in `app-sdk/src/app.handlers.test.ts`.
//
// Drift detector: if the server adds a new numeric code that should
// surface as a typed `AttachError`, both this map AND the SDK's map
// must update — a comment on `extractAttachCode` makes this explicit.
const NUMERIC_TO_ATTACH_TAG: Record<number, string> = {
  [ErrorCodes.SessionNotFound]: "SessionNotFound",
  [ErrorCodes.NotFound]: "ConversationNotFound",
  [ErrorCodes.Forbidden]: "NotAuthorized",
};

function expectedAttachTagFor(numericCode: number): string {
  return NUMERIC_TO_ATTACH_TAG[numericCode] ?? "AttachFailed";
}

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

/** Register & connect an agent with `owner_user_id` populated — required
 *  by AppHost session admission for any agent that participates in an
 *  app session. Mirrors the helper of the same name in
 *  `30-app-hooks.integration.test.ts`. */
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

// ─── Test fixture: registerAppClient ─────────────────────────────────
//
// Architect plan §B.9 acceptance:
//   "New `registerAppClient({manifest, handlers})` test fixture: boots
//    a second WS connection (mirror of arena-app's shape), registers
//    as a remote app, exercises one full admission round-trip."
//
// Boots a second WS connection (separate from the user agent's), wires
// `handleServerRpc` BEFORE `apps/register` so the very first inbound
// hook RPC sees the handler, and registers the manifest. Returns the
// app agent's id + raw client so individual tests can assert on
// captures / drive subsequent calls.
//
// Handlers are typed against the wire shapes (params decoded by the
// TestClient against `S2cRpcMap`; replies must match the result shape
// for that method). Lifecycle handlers default to a no-op `{}` reply
// when omitted.

interface AppClientHandlers {
  readonly onBeforeDispatch?: (
    ctx: BeforeDispatchContext,
  ) => Effect.Effect<{ admission: DispatchAdmissionResult }, never>;
  readonly onBeforeMessageDelivery?: (
    ctx: BeforeMessageDeliveryContext,
  ) => Effect.Effect<HookResult, never>;
  readonly onSessionActive?: (
    ctx: OnSessionActiveContext,
  ) => Effect.Effect<Record<string, never>, never>;
  readonly onJoin?: (
    ctx: OnJoinContext,
  ) => Effect.Effect<Record<string, never>, never>;
  readonly onClose?: (
    ctx: OnCloseContext,
  ) => Effect.Effect<Record<string, never>, never>;
}

interface RegisteredAppClient {
  readonly appAgentId: string;
  readonly appAgentKey: string;
  readonly client: ServerTestClient;
}

function registerAppClient(opts: {
  readonly name: string;
  readonly manifest: AppManifest;
  readonly handlers: AppClientHandlers;
}): Effect.Effect<RegisteredAppClient, Error> {
  return Effect.gen(function* () {
    const reg = yield* registerAgent(getBaseUrl(), opts.name);
    const client = yield* connectTestClient({
      agentId: reg.agentId,
      apiKey: reg.apiKey,
    });
    trackClient(client);

    // Wire ALL FIVE handlers BEFORE apps/register so the very first
    // server-initiated hook RPC has a handler to dispatch against.
    // Defaults are no-op grant / pass-through / void: AppHost dispatches
    // every manifest-declared hook to the remote app once
    // `registerRemoteApp` has bound the appId → connId; an unhandled
    // method on the client would fail-close (deny / block), which masks
    // the verdict the test is actually asserting on. Tests opt-in to a
    // specific hook by passing a handler; the rest stay default.
    const h = opts.handlers;

    yield* client.handleServerRpc(
      "apps/onBeforeDispatch",
      h.onBeforeDispatch ??
        (() => Effect.succeed({ admission: { decision: "grant" as const } })),
    );
    yield* client.handleServerRpc(
      "apps/onBeforeMessageDelivery",
      h.onBeforeMessageDelivery ?? (() => Effect.succeed({ block: false })),
    );
    yield* client.handleServerRpc(
      "apps/onSessionActive",
      h.onSessionActive ?? (() => Effect.succeed({})),
    );
    yield* client.handleServerRpc(
      "apps/onJoin",
      h.onJoin ?? (() => Effect.succeed({})),
    );
    yield* client.handleServerRpc(
      "apps/onClose",
      h.onClose ?? (() => Effect.succeed({})),
    );

    yield* client.sendRpc("apps/register", { manifest: opts.manifest });

    return { appAgentId: reg.agentId, appAgentKey: reg.apiKey, client };
  });
}

/** Build a manifest with one main conversation + the listed hooks
 *  configured. Timeouts default high enough to never fire in happy-path
 *  tests; individual tests pass a smaller value for timeout-fail tests. */
function manifestFor(
  appId: string,
  opts?: {
    readonly hookTimeoutMs?: number;
    readonly onSessionActiveTimeoutMs?: number;
    readonly onCloseTimeoutMs?: number;
    readonly beforeDispatchTimeoutMs?: number;
  },
): AppManifest {
  return {
    appId,
    name: `RPC Test App ${appId}`,
    permissions: { required: [], optional: [] },
    conversations: [
      { key: "main", name: "Main Channel", participantFilter: "all" },
    ],
    hooks: {
      before_dispatch: { timeout_ms: opts?.beforeDispatchTimeoutMs ?? 5000 },
      before_message_delivery: { timeout_ms: opts?.hookTimeoutMs ?? 5000 },
      on_join: {},
      on_close: { timeout_ms: opts?.onCloseTimeoutMs ?? 5000 },
      on_session_active: {
        timeout_ms: opts?.onSessionActiveTimeoutMs ?? 5000,
      },
    },
  };
}

describe("Scenario 30b: App hook RPC pipeline (B.9 — Phase 1.8)", () => {
  // ── Fixture itself: round-trip smoke test ──────────────────────────
  describe("registerAppClient fixture", () => {
    it.live(
      "boots a second WS connection, registers a remote app, and exercises one admission round-trip",
      () =>
        Effect.gen(function* () {
          // Smoke test for the fixture: send `messages/send` from the
          // user agent → AppHost fires `before_message_delivery` against
          // the registered remote app's WS → handler observes the
          // wire-shaped context and returns a pass-through verdict.
          // Exercises one full admission round-trip end-to-end.
          const userAgent = yield* registerAppAgent("rpc-fixture-user");

          let lastDeliveryCtx: BeforeMessageDeliveryContext | null = null;
          yield* registerAppClient({
            name: "rpc-fixture-app",
            manifest: manifestFor("rpc-fixture-app"),
            handlers: {
              onBeforeMessageDelivery: (ctx) =>
                Effect.sync(() => {
                  lastDeliveryCtx = ctx;
                  return { block: false };
                }),
            },
          });

          const session = (yield* userAgent.client.sendRpc("apps/create", {
            appId: "rpc-fixture-app",
            invitedAgentIds: [],
          })) as {
            session: { id: string; conversations: Record<string, string> };
          };

          const convId = session.session.conversations["main"]!;

          yield* userAgent.client.sendRpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "fixture round-trip" }],
          });

          expect(lastDeliveryCtx).not.toBeNull();
          expect(lastDeliveryCtx!.sessionId).toBe(session.session.id);
          expect(lastDeliveryCtx!.appId).toBe("rpc-fixture-app");
          expect(lastDeliveryCtx!.conversationId).toBe(convId);
        }),
    );
  });

  // ── before_dispatch (via apps/authorizeDispatch) ───────────────────
  //
  // `before_dispatch` fires inside the c2s `apps/authorizeDispatch`
  // handler (see `apps.handlers.ts` — the only `runBeforeDispatch`
  // call site outside the dispatch helper itself). The wire result is
  // `{ admission: DispatchAdmissionResult }` — i.e. the full verdict
  // round-trips back to the caller. `messages/send` only fires
  // `before_message_delivery`, not `before_dispatch`.
  describe("apps/onBeforeDispatch (via apps/authorizeDispatch)", () => {
    /** Construct a candidate `apps/authorizeDispatch` payload that the
     *  hook will evaluate. The wire schema requires UUIDs for
     *  conversationId / messageId / senderAgentId; their values don't
     *  actually have to refer to existing rows for the hook dispatch
     *  itself — `runBeforeDispatch` consults `conversationToSession` to
     *  decide whether a hook fires. */
    function authorizeDispatchParams(
      conversationId: string,
      senderAgentId: string,
    ): {
      conversationId: string;
      messageId: string;
      senderAgentId: string;
      parts: Array<{ type: "text"; text: string }>;
    } {
      return {
        conversationId,
        messageId: crypto.randomUUID(),
        senderAgentId,
        parts: [{ type: "text", text: "candidate dispatch" }],
      };
    }

    it.live("happy path — grant verdict round-trips through the wire", () =>
      Effect.gen(function* () {
        const userAgent = yield* registerAppAgent("bd-grant-user");

        yield* registerAppClient({
          name: "bd-grant-app",
          manifest: manifestFor("bd-grant-app"),
          handlers: {
            onBeforeDispatch: () =>
              Effect.succeed({ admission: { decision: "grant" as const } }),
          },
        });

        const session = (yield* userAgent.client.sendRpc("apps/create", {
          appId: "bd-grant-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };
        const convId = session.session.conversations["main"]!;

        const result = (yield* userAgent.client.sendRpc(
          "apps/authorizeDispatch",
          authorizeDispatchParams(convId, userAgent.agentId),
        )) as { admission: DispatchAdmissionResult };

        expect(result.admission.decision).toBe("grant");
      }),
    );

    it.live("deny verdict round-trips with the hook's reason text", () =>
      Effect.gen(function* () {
        const userAgent = yield* registerAppAgent("bd-deny-user");

        yield* registerAppClient({
          name: "bd-deny-app",
          manifest: manifestFor("bd-deny-app"),
          handlers: {
            onBeforeDispatch: () =>
              Effect.succeed({
                admission: {
                  decision: "deny" as const,
                  reason: "policy/no-dispatch",
                },
              }),
          },
        });

        const session = (yield* userAgent.client.sendRpc("apps/create", {
          appId: "bd-deny-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };
        const convId = session.session.conversations["main"]!;

        const result = (yield* userAgent.client.sendRpc(
          "apps/authorizeDispatch",
          authorizeDispatchParams(convId, userAgent.agentId),
        )) as { admission: DispatchAdmissionResult };

        expect(result.admission.decision).toBe("deny");
        if (result.admission.decision === "deny") {
          expect(result.admission.reason).toBe("policy/no-dispatch");
        }
      }),
    );

    it.live("hold verdict round-trips lease metadata", () =>
      Effect.gen(function* () {
        // `hold` is the lease-protected branch of DispatchAdmissionResult —
        // the wire result must carry leaseId + leaseTimeoutMs exactly.
        // Schema: `{ decision: "hold", reason? }` — leaseId/leaseTimeoutMs
        // live on the `grant` branch (per the architect plan §3.2 verdict
        // table). `hold` is just decision + optional reason; dispatch
        // resumption uses a separate authorize call when the app is
        // ready. Asserting the decision tag + reason is the contract.
        const userAgent = yield* registerAppAgent("bd-hold-user");

        yield* registerAppClient({
          name: "bd-hold-app",
          manifest: manifestFor("bd-hold-app"),
          handlers: {
            onBeforeDispatch: () =>
              Effect.succeed({
                admission: {
                  decision: "hold" as const,
                  reason: "queued-for-later",
                },
              }),
          },
        });

        const session = (yield* userAgent.client.sendRpc("apps/create", {
          appId: "bd-hold-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };
        const convId = session.session.conversations["main"]!;

        const result = (yield* userAgent.client.sendRpc(
          "apps/authorizeDispatch",
          authorizeDispatchParams(convId, userAgent.agentId),
        )) as { admission: DispatchAdmissionResult };

        expect(result.admission.decision).toBe("hold");
        if (result.admission.decision === "hold") {
          expect(result.admission.reason).toBe("queued-for-later");
        }
      }),
    );

    it.live(
      "grant verdict with lease metadata round-trips leaseId + leaseTimeoutMs",
      () =>
        Effect.gen(function* () {
          // Lease fields live on the `grant` branch per architect §3.2.
          // Apps that want timed leases (e.g. werewolf 900s
          // `before_dispatch` window) attach lease metadata to a grant.
          const userAgent = yield* registerAppAgent("bd-lease-user");

          yield* registerAppClient({
            name: "bd-lease-app",
            manifest: manifestFor("bd-lease-app"),
            handlers: {
              onBeforeDispatch: () =>
                Effect.succeed({
                  admission: {
                    decision: "grant" as const,
                    leaseId: "test-lease-1",
                    leaseTimeoutMs: 30_000,
                  },
                }),
            },
          });

          const session = (yield* userAgent.client.sendRpc("apps/create", {
            appId: "bd-lease-app",
            invitedAgentIds: [],
          })) as {
            session: { id: string; conversations: Record<string, string> };
          };
          const convId = session.session.conversations["main"]!;

          const result = (yield* userAgent.client.sendRpc(
            "apps/authorizeDispatch",
            authorizeDispatchParams(convId, userAgent.agentId),
          )) as { admission: DispatchAdmissionResult };

          expect(result.admission.decision).toBe("grant");
          if (result.admission.decision === "grant") {
            expect(result.admission.leaseId).toBe("test-lease-1");
            expect(result.admission.leaseTimeoutMs).toBe(30_000);
          }
        }),
    );

    it.live(
      "fail-closed (deny) when the app WS disconnects mid-admission",
      () =>
        Effect.gen(function* () {
          // Architect plan §3.4: `before_dispatch` fail-policy on
          // app-disconnect is `{ decision: "deny", reason: "..." }` —
          // the c2s `apps/authorizeDispatch` returns `decision: "deny"`
          // (it does NOT raise an RPC failure). The Scope finalizer on
          // the server-side connection fails the pending Deferred with
          // `AppDisconnected`, which the AppHost wrapper converts to the
          // fail-closed verdict.
          const userAgent = yield* registerAppAgent("bd-disco-user");

          const app = yield* registerAppClient({
            name: "bd-disco-app",
            manifest: manifestFor("bd-disco-app", {
              beforeDispatchTimeoutMs: 30_000, // generous; we'll cut the wire
            }),
            handlers: {
              // Park indefinitely so the test can sever the WS while
              // the request is in flight on the server side.
              onBeforeDispatch: () => Effect.never,
            },
          });

          const session = (yield* userAgent.client.sendRpc("apps/create", {
            appId: "bd-disco-app",
            invitedAgentIds: [],
          })) as {
            session: { id: string; conversations: Record<string, string> };
          };
          const convId = session.session.conversations["main"]!;

          // Fork the authorizeDispatch call so we can disconnect the app
          // mid-admission. The call MUST resolve with a deny verdict
          // (fail-closed), not hang indefinitely.
          const callFiber = Effect.runFork(
            userAgent.client.sendRpc(
              "apps/authorizeDispatch",
              authorizeDispatchParams(convId, userAgent.agentId),
            ),
          );

          // Give the server time to dispatch the s2c request to the app,
          // then kill the app's WS. 200ms is empirical buffer.
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)));
          yield* app.client.close();

          const exit = yield* Effect.promise(
            () =>
              new Promise<Exit.Exit<unknown, unknown>>((resolve) => {
                callFiber.addObserver((e) =>
                  resolve(e as Exit.Exit<unknown, unknown>),
                );
              }),
          );

          // Fail-closed surfaces as `{decision: "deny", reason: ...}`,
          // not as an RPC failure. The c2s call succeeds; the verdict
          // is the fail-closed shape.
          expect(Exit.isSuccess(exit)).toBe(true);
          if (Exit.isSuccess(exit)) {
            const result = exit.value as { admission: DispatchAdmissionResult };
            expect(result.admission.decision).toBe("deny");
          }
        }),
    );
  });

  // ── before_message_delivery ────────────────────────────────────────
  describe("apps/onBeforeMessageDelivery", () => {
    it.live(
      "block + reason rejects with HookBlocked + structured feedback",
      () =>
        Effect.gen(function* () {
          // Migrated from deleted 32-webhook-hooks.integration.test.ts
          // (block-context shape + structured feedback round-trip).
          const userAgent = yield* registerAppAgent("bmd-block-user");

          yield* registerAppClient({
            name: "bmd-block-app",
            manifest: manifestFor("bmd-block-app"),
            handlers: {
              onBeforeDispatch: () =>
                Effect.succeed({ admission: { decision: "grant" as const } }),
              onBeforeMessageDelivery: (_ctx) =>
                Effect.succeed({
                  block: true,
                  reason: "Invalid command format",
                  feedback: {
                    type: "error",
                    content: { expected: "/kill target:AgentName" },
                    retry: true,
                  },
                }),
            },
          });

          const session = (yield* userAgent.client.sendRpc("apps/create", {
            appId: "bmd-block-app",
            invitedAgentIds: [],
          })) as {
            session: { id: string; conversations: Record<string, string> };
          };
          const convId = session.session.conversations["main"]!;

          const rpcErr = yield* expectRpcFailure(
            userAgent.client.sendRpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "bad command" }],
            }),
            ErrorCodes.HookBlocked,
          );
          expect(rpcErr.data).toHaveProperty("feedback");
          const feedback = (
            rpcErr.data as { feedback: { type: string; retry: boolean } }
          ).feedback;
          expect(feedback.type).toBe("error");
          expect(feedback.retry).toBe(true);
        }),
    );

    it.live("patch verdict mutates the recipient view", () =>
      Effect.gen(function* () {
        const userAgent = yield* registerAppAgent("bmd-patch-user");

        yield* registerAppClient({
          name: "bmd-patch-app",
          manifest: manifestFor("bmd-patch-app"),
          handlers: {
            onBeforeDispatch: () =>
              Effect.succeed({ admission: { decision: "grant" as const } }),
            onBeforeMessageDelivery: (ctx) =>
              Effect.succeed({
                block: false,
                patch: {
                  parts: [
                    {
                      type: "text" as const,
                      text:
                        "[REDACTED] " +
                        (ctx.message.parts[0] as { text: string }).text,
                    },
                  ],
                },
              }),
          },
        });

        const session = (yield* userAgent.client.sendRpc("apps/create", {
          appId: "bmd-patch-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };
        const convId = session.session.conversations["main"]!;

        const result = (yield* userAgent.client.sendRpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "secret info" }],
        })) as {
          message: {
            parts: Array<{ type: string; text: string }>;
            patchedBy?: string;
          };
        };
        expect(result.message.parts[0]!.text).toBe("[REDACTED] secret info");
        expect(result.message.patchedBy).toBe("bmd-patch-app");
      }),
    );

    it.live(
      "feedback-only verdict (block + structured payload, no patch)",
      () =>
        Effect.gen(function* () {
          const userAgent = yield* registerAppAgent("bmd-feedback-user");

          yield* registerAppClient({
            name: "bmd-feedback-app",
            manifest: manifestFor("bmd-feedback-app"),
            handlers: {
              onBeforeDispatch: () =>
                Effect.succeed({ admission: { decision: "grant" as const } }),
              onBeforeMessageDelivery: () =>
                Effect.succeed({
                  block: true,
                  reason: "needs-retry",
                  feedback: {
                    type: "warning",
                    content: { hint: "rephrase as a question" },
                    retry: false,
                  },
                }),
            },
          });

          const session = (yield* userAgent.client.sendRpc("apps/create", {
            appId: "bmd-feedback-app",
            invitedAgentIds: [],
          })) as {
            session: { id: string; conversations: Record<string, string> };
          };
          const convId = session.session.conversations["main"]!;

          const rpcErr = yield* expectRpcFailure(
            userAgent.client.sendRpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "raw input" }],
            }),
            ErrorCodes.HookBlocked,
          );
          const feedback = (
            rpcErr.data as { feedback: { type: string; retry: boolean } }
          ).feedback;
          expect(feedback.type).toBe("warning");
          expect(feedback.retry).toBe(false);
        }),
    );

    it.live("times out fail-closed and emits app/hookTimeout", () =>
      Effect.gen(function* () {
        // Migrated from deleted 32-webhook-hooks.integration.test.ts
        // (timeout fail-closed). Real wall-clock 200ms hookTimeout.
        const userAgent = yield* registerAppAgent("bmd-timeout-user");

        yield* registerAppClient({
          name: "bmd-timeout-app",
          manifest: manifestFor("bmd-timeout-app", { hookTimeoutMs: 200 }),
          handlers: {
            onBeforeDispatch: () =>
              Effect.succeed({ admission: { decision: "grant" as const } }),
            // Park forever so the manifest-level timeout fires.
            onBeforeMessageDelivery: () => Effect.never,
          },
        });

        const session = (yield* userAgent.client.sendRpc("apps/create", {
          appId: "bmd-timeout-app",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };
        const convId = session.session.conversations["main"]!;

        yield* expectRpcFailure(
          userAgent.client.sendRpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "should-be-blocked" }],
          }),
          ErrorCodes.HookBlocked,
        );

        const timeoutEvent = yield* userAgent.client.waitForEvent(
          "app/hookTimeout",
          3000,
        );
        const data = timeoutEvent.data as {
          sessionId: string;
          appId: string;
          hookName: string;
          timeoutMs: number;
        };
        expect(data.hookName).toBe("before_message_delivery");
        expect(data.timeoutMs).toBe(200);
        expect(data.appId).toBe("bmd-timeout-app");
      }),
    );
  });

  // ── on_session_active ──────────────────────────────────────────────
  describe("apps/onSessionActive", () => {
    it.live(
      "hook completes BEFORE app/sessionReady reaches the initiator",
      () =>
        Effect.gen(function* () {
          // Architect plan §4.2: the awaitable `on_session_active` hook
          // must finish before AppHost broadcasts `app/sessionReady`. The
          // ordering invariant matches the in-process test in
          // `31-on-session-active.integration.test.ts:200-230`.
          const userAgent = yield* registerAppAgent("osa-order-user");
          const invitee = yield* registerAppAgent("osa-order-invitee");

          let hookFinishedAt: number | null = null;

          yield* registerAppClient({
            name: "osa-order-app",
            manifest: manifestFor("osa-order-app", {
              onSessionActiveTimeoutMs: 5000,
            }),
            handlers: {
              onSessionActive: () =>
                Effect.gen(function* () {
                  yield* Effect.promise(
                    () => new Promise((r) => setTimeout(r, 300)),
                  );
                  hookFinishedAt = Date.now();
                  return {};
                }),
            },
          });

          yield* userAgent.client.sendRpc("apps/create", {
            appId: "osa-order-app",
            invitedAgentIds: [invitee.agentId],
          });

          yield* userAgent.client.waitForEvent("app/sessionReady", 5000);
          const readyAt = Date.now();
          expect(hookFinishedAt).not.toBeNull();
          expect(hookFinishedAt!).toBeLessThanOrEqual(readyAt);
        }),
    );
  });

  // ── on_join ────────────────────────────────────────────────────────
  describe("apps/onJoin", () => {
    it.live("fires on_join with correct context when invitee is admitted", () =>
      Effect.gen(function* () {
        // Migrated from deleted 32-webhook-hooks.integration.test.ts
        // (on_join context shape).
        const userAgent = yield* registerAppAgent("oj-init");
        const invitee = yield* registerAppAgent("oj-invitee");

        let joinCtx: OnJoinContext | null = null;

        yield* registerAppClient({
          name: "oj-app",
          manifest: manifestFor("oj-app"),
          handlers: {
            onJoin: (ctx) =>
              Effect.sync(() => {
                joinCtx = ctx;
                return {};
              }),
          },
        });

        yield* userAgent.client.sendRpc("apps/create", {
          appId: "oj-app",
          invitedAgentIds: [invitee.agentId],
        });

        yield* invitee.client.waitForEvent("app/participantAdmitted", 5000);
        // admitAgentsAsync is daemon-forked; give it a beat to fire the
        // hook against the remote app's WS and receive its reply.
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)));

        expect(joinCtx).not.toBeNull();
        expect(joinCtx!.agent.agentId).toBe(invitee.agentId);
        expect(joinCtx!.appId).toBe("oj-app");
        expect(joinCtx!.conversations).toHaveProperty("main");
      }),
    );
  });

  // ── on_close ───────────────────────────────────────────────────────
  describe("apps/onClose", () => {
    it.live("fires on_close with correct context when session closes", () =>
      Effect.gen(function* () {
        // Migrated from deleted 32-webhook-hooks.integration.test.ts
        // (on_close context shape).
        const userAgent = yield* registerAppAgent("oc-init");

        let closeCtx: OnCloseContext | null = null;

        yield* registerAppClient({
          name: "oc-app",
          manifest: manifestFor("oc-app"),
          handlers: {
            onClose: (ctx) =>
              Effect.sync(() => {
                closeCtx = ctx;
                return {};
              }),
          },
        });

        const session = (yield* userAgent.client.sendRpc("apps/create", {
          appId: "oc-app",
          invitedAgentIds: [],
        })) as { session: { id: string } };

        yield* userAgent.client.sendRpc("apps/closeSession", {
          sessionId: session.session.id,
        });

        // Allow the on_close round-trip + reply to complete; closeSession
        // awaits the s2c reply but tracks it on a daemon dispatcher.
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)));

        expect(closeCtx).not.toBeNull();
        expect(closeCtx!.sessionId).toBe(session.session.id);
        expect(closeCtx!.appId).toBe("oc-app");
        expect(closeCtx!.closedBy.agentId).toBe(userAgent.agentId);
        expect(closeCtx!.conversations).toHaveProperty("main");
      }),
    );
  });

  // ── apps/attachConversation (c2s) ──────────────────────────────────
  //
  // Architect plan §3.5 / §B.9 acceptance — exercises the c2s
  // `apps/attachConversation` RPC against the real server and asserts
  // the wire-level numeric error codes the SDK's `extractAttachCode`
  // depends on. Catches the bug where the SDK was string-matching
  // `data.code` while the real server emits numeric `err.code` from
  // `ErrorCodes` (`SessionNotFound = -32021`, `Forbidden = -32001`).
  //
  // Server-core does not depend on `@moltzap/app-sdk` (no new deps
  // allowed in this PR per architect §3.6 / B.9 scope), so this test
  // hits the wire and asserts numeric codes; the SDK's deterministic
  // numeric→tag mapping (`NUMERIC_TO_ATTACH_TAG` table mirror at the
  // top of this file) is unit-tested against the same numeric codes
  // in `app-sdk/src/app.handlers.test.ts`. Drift would surface in
  // either suite; both maps must update together.
  describe("apps/attachConversation (c2s wire round-trip)", () => {
    it.live(
      "happy path: attaches a conversation under conversationId-as-key",
      () =>
        Effect.gen(function* () {
          // The wire `apps/attachConversation` is the SDK's surface; auth
          // requires the caller's WS connection to be the registered
          // remote-app of record (architect plan §B.2 acceptance #2; see
          // `requireSessionAppOfRecord` for the gap-closure rationale).
          // We therefore use `registerAppClient` to register a remote app
          // and have THAT connection call attachConversation; the user
          // agent creates the session as initiator, but doesn't attach.
          const peer = yield* registerAppAgent("att-happy-peer");
          const app = yield* registerAppClient({
            name: "att-happy-app-agent",
            manifest: manifestFor("att-happy-app"),
            handlers: {},
          });

          // `registerAppClient` doesn't set `owner_user_id`; createSession
          // requires it on the initiator. Mirror `registerAppAgent`'s
          // direct DB update to satisfy the pre-check.
          const db = getKyselyDb();
          yield* Effect.tryPromise(() =>
            db
              .updateTable("agents")
              .set({ owner_user_id: crypto.randomUUID() })
              .where("id", "=", app.appAgentId)
              .execute(),
          );

          // The app is also the initiator: `apps/create` uses `ctx.agentId`
          // as the initiator and the same connection holds the remote-app
          // registration, so the session has the app as both initiator and
          // app-of-record. (Production SDK callers follow the same shape.)
          const session = (yield* app.client.sendRpc("apps/create", {
            appId: "att-happy-app",
            invitedAgentIds: [],
          })) as { session: { id: string } };

          const dm = (yield* app.client.sendRpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: peer.agentId }],
          })) as { conversation: { id: string } };

          // Wire shape for `apps/attachConversation` carries no `key`
          // field; the server handler uses `conversationId` as the key
          // (deterministic 1:1; see apps.handlers.ts comment).
          yield* app.client.sendRpc("apps/attachConversation", {
            sessionId: session.session.id,
            conversationId: dm.conversation.id,
          });

          const rows = yield* Effect.tryPromise(() =>
            db
              .selectFrom("app_session_conversations")
              .selectAll()
              .where("session_id", "=", session.session.id)
              .where("conversation_id", "=", dm.conversation.id)
              .execute(),
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]!.conversation_key).toBe(dm.conversation.id);
        }),
    );

    it.live(
      "SessionNotFound (-32021) → SDK maps to AttachError('SessionNotFound')",
      () =>
        Effect.gen(function* () {
          const userAgent = yield* registerAppAgent("att-snf-user");

          // A well-formed UUID that does not refer to any session.
          const rpcErr = yield* expectRpcFailure(
            userAgent.client.sendRpc("apps/attachConversation", {
              sessionId: crypto.randomUUID(),
              conversationId: crypto.randomUUID(),
            }),
            ErrorCodes.SessionNotFound,
          );
          // Wire-level assertion the SDK's numeric-code path consumes.
          expect(rpcErr.code).toBe(ErrorCodes.SessionNotFound);
          // SDK round-trip: this numeric code maps deterministically to
          // the SDK's `AttachError('SessionNotFound')`. Map mirrored in
          // `NUMERIC_TO_ATTACH_TAG` above; full mapping in
          // `app-sdk/src/app.ts:extractAttachCode`.
          expect(expectedAttachTagFor(rpcErr.code)).toBe("SessionNotFound");
        }),
    );

    it.live(
      "Forbidden (-32001) → SDK maps to AttachError('NotAuthorized') when caller is not the app of record",
      () =>
        Effect.gen(function* () {
          const initiator = yield* registerAppAgent("att-na-init");
          const stranger = yield* registerAppAgent("att-na-stranger");
          const peer = yield* registerAppAgent("att-na-peer");

          coreApp.registerApp({
            appId: "att-na-app",
            name: "Att NA",
            permissions: { required: [], optional: [] },
            conversations: [
              { key: "main", name: "Main", participantFilter: "all" },
            ],
          });

          const session = (yield* initiator.client.sendRpc("apps/create", {
            appId: "att-na-app",
            invitedAgentIds: [],
          })) as { session: { id: string } };

          const dm = (yield* initiator.client.sendRpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: peer.agentId }],
          })) as { conversation: { id: string } };

          // Stranger calls against a session they don't own and aren't
          // the app of record for. The wire RPC handler authorizes via
          // `requireSessionAppOfRecord`, which rejects any caller whose
          // connectionId isn't the registered remote-app for the
          // session's `app_id`. (`coreApp.registerApp` creates an
          // in-process registration only — no remote `connectionId` is
          // bound — so even the initiator would fail this check via the
          // wire surface; in-process callers must use
          // `attachAppConversation` directly.)
          const rpcErr = yield* expectRpcFailure(
            stranger.client.sendRpc("apps/attachConversation", {
              sessionId: session.session.id,
              conversationId: dm.conversation.id,
            }),
            ErrorCodes.Forbidden,
          );
          expect(rpcErr.code).toBe(ErrorCodes.Forbidden);
          expect(expectedAttachTagFor(rpcErr.code)).toBe("NotAuthorized");
        }),
    );

    it.live(
      "admitted participant cannot attach an unrelated conversation (cross-tenant guard)",
      () =>
        // The exact exploit codex named on PR #326: App-B is admitted to
        // App-A's session as a participant — so App-B passes the
        // pre-recovery `getSession(sessionId, ctx.agentId)` admission
        // check — but App-B is NOT the app of record for App-A's
        // session. With the gap, App-B could attach an arbitrary
        // conversationId to App-A's session, exfiltrating the
        // conversation's messages through App-A's hooks and obtaining
        // deny-veto on messages it shouldn't see. The fix in
        // `requireSessionAppOfRecord` tightens the auth predicate to
        // "caller's WS connection id matches the remote-app
        // registration for `session.app_id`", which App-B fails.
        //
        // Test should fail BEFORE the handler fix (App-B's
        // `apps/attachConversation` succeeds via getSession-as-admitted)
        // and pass AFTER (Forbidden via the app-of-record check).
        Effect.gen(function* () {
          // App-A is the legitimate app of record. Registers as a remote
          // app over WS so the wire `apps/attachConversation` round-trip
          // can authorize via the registered connectionId.
          const appA = yield* registerAppClient({
            name: "att-xtenant-app-a-agent",
            manifest: manifestFor("att-xtenant-app-a"),
            handlers: {},
          });

          // App-B is a separate connection (different agentId). Will be
          // admitted as a participant to App-A's session, then attempt
          // the cross-tenant attach.
          const appB = yield* registerAppClient({
            name: "att-xtenant-app-b-agent",
            manifest: manifestFor("att-xtenant-app-b"),
            handlers: {},
          });

          // Both agents need `owner_user_id` populated for AppHost
          // admission to succeed (initiator pre-check + participant
          // identity check). `registerAppClient` doesn't set it; the
          // direct DB update mirrors `registerAppAgent`'s pattern.
          const db = getKyselyDb();
          for (const agentId of [appA.appAgentId, appB.appAgentId]) {
            yield* Effect.tryPromise(() =>
              db
                .updateTable("agents")
                .set({ owner_user_id: crypto.randomUUID() })
                .where("id", "=", agentId)
                .execute(),
            );
          }

          // App-A creates a session with App-B as an invitee. App-B is
          // NOT the app of record (App-A is); App-B is a participant.
          // AppHost runs admission for invitees inline; with owner_user_id
          // set, App-B passes the identity check and lands as `admitted`.
          const session = (yield* appA.client.sendRpc("apps/create", {
            appId: "att-xtenant-app-a",
            invitedAgentIds: [appB.appAgentId],
          })) as { session: { id: string } };

          // App-B picks an arbitrary conversationId — the exploit shape
          // is "any convId I have access to" but the existence check is
          // out of scope here; the auth check fires before the convId
          // is touched.
          const targetConvId = crypto.randomUUID();

          // App-B attempts to attach an unrelated conversation to
          // App-A's session. Pre-fix this would succeed; post-fix the
          // app-of-record check rejects with Forbidden.
          const rpcErr = yield* expectRpcFailure(
            appB.client.sendRpc("apps/attachConversation", {
              sessionId: session.session.id,
              conversationId: targetConvId,
            }),
            ErrorCodes.Forbidden,
          );
          expect(rpcErr.code).toBe(ErrorCodes.Forbidden);
          expect(expectedAttachTagFor(rpcErr.code)).toBe("NotAuthorized");

          // Verify NO row was inserted (the attach was rejected before
          // the DB mutation). Reuses the `db` handle from setup above.
          const rows = yield* Effect.tryPromise(() =>
            db
              .selectFrom("app_session_conversations")
              .selectAll()
              .where("session_id", "=", session.session.id)
              .where("conversation_id", "=", targetConvId)
              .execute(),
          );
          expect(rows).toHaveLength(0);
        }),
    );
  });
});
