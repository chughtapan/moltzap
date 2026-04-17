// ─────────────────────────────────────────────────────────────────────
// INTEGRATION-LEVEL TIMEOUTS ARE REAL-TIME — TestClock does NOT apply.
//
// This file exercises the full server pipeline: PGlite DB, WebSocket
// listener, per-connection fibers inside the server's ManagedRuntime,
// and a real MoltZap client talking to it over a localhost socket. The
// server's Effect fibers run in a scope we do NOT control from the
// test, so `@effect/vitest`'s `TestClock` (which replaces the Clock
// service for the *test's* fiber) cannot advance time inside the
// server's fibers. Any attempt to do so here would fail: the test would
// move on while the server still sees wall-clock time, producing a
// torn-clock race.
//
// Consequences:
//   - `hookTimeoutMs: 200` / `timeoutMs: 150` are burned as real 200 /
//     150 ms waits in CI. That's the cost of full-stack coverage for
//     hook fail-closed semantics.
//   - Raw `await new Promise(r => setTimeout(r, ...))` sleeps below are
//     unavoidable at this layer.
//
// Candidates for moving down to pure-Effect unit tests (no DB, no
// socket, no cross-process fibers):
//   - `runHookWithTimeout` fail-closed timeout branch — it's a method
//     on `AppHost` that wraps a user hook in `Effect.tryPromise` +
//     `Effect.timeout`. Testing it against a fake Broadcaster +
//     in-memory Kysely (or just the bare Effect) would give us
//     TestClock control over the 200ms timeout. See `aborts the hook's
//     AbortSignal on timeout` (L298) and `times out, blocks the
//     message…` (L184) — both would gain >500ms each at the unit
//     level.
//   - `PermissionService.requestPermission` timeout is already covered
//     at unit level in `src/app/app-host.test.ts` (fake timers), so
//     no need to add a second integration copy.
//
// Leave these as integration tests until the `AppHost` class is
// refactored enough that `runHookWithTimeout` can be exercised without
// bringing up the whole server harness.
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";
import type { CoreApp } from "../../app/types.js";
import { ErrorCodes } from "@moltzap/protocol";
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

/** Register, connect, and assign an owner_user_id (required for app sessions). */
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
  opts?: { hookTimeoutMs?: number },
) {
  app.registerApp({
    appId,
    name: `Test App ${appId}`,
    permissions: { required: [], optional: [] },
    conversations: [
      { key: "main", name: "Main Channel", participantFilter: "all" },
    ],
    hooks: {
      before_message_delivery: {
        timeout_ms: opts?.hookTimeoutMs ?? 5000,
      },
      on_join: {},
    },
  });
}

describe("Scenario 30: App Hooks", () => {
  describe("before_message_delivery", () => {
    it.live("blocks a message and returns structured feedback", () =>
      Effect.gen(function* () {
        const orchestrator = yield* registerAppAgent("orchestrator");

        registerTestApp(coreApp, "test-blocker");

        coreApp.onBeforeMessageDelivery("test-blocker", (ctx) => ({
          block: true,
          reason: "Invalid command format",
          feedback: {
            type: "error",
            content: {
              expected: "/kill target:AgentName",
              got: ctx.message.parts,
            },
            retry: true,
          },
        }));

        const session = (yield* orchestrator.client.sendRpc("apps/create", {
          appId: "test-blocker",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        const result = yield* Effect.either(
          orchestrator.client.sendRpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "bad command" }],
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          const rpcErr = result.left as unknown as {
            code: number;
            message: string;
            data?: unknown;
          };
          expect(rpcErr.code).toBe(ErrorCodes.HookBlocked);
          expect(rpcErr.message).toContain("Invalid command format");
          expect(rpcErr.data).toHaveProperty("feedback");
          const feedback = (
            rpcErr.data as {
              feedback: { type: string; retry: boolean };
            }
          ).feedback;
          expect(feedback.type).toBe("error");
          expect(feedback.retry).toBe(true);
        }
      }),
    );

    it.live("patches message parts before delivery", () =>
      Effect.gen(function* () {
        const alice = yield* registerAppAgent("alice-hook");

        registerTestApp(coreApp, "test-patcher");

        coreApp.onBeforeMessageDelivery("test-patcher", (ctx) => ({
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
        }));

        const session = (yield* alice.client.sendRpc("apps/create", {
          appId: "test-patcher",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        const result = (yield* alice.client.sendRpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "secret info" }],
        })) as {
          message: {
            parts: Array<{ type: string; text: string }>;
            patchedBy?: string;
          };
        };

        expect(result.message.parts[0]!.text).toBe("[REDACTED] secret info");
        expect(result.message.patchedBy).toBe("test-patcher");
      }),
    );

    it.live("passes through when hook allows", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("passthrough-agent");

        registerTestApp(coreApp, "test-passthrough");

        coreApp.onBeforeMessageDelivery("test-passthrough", () => ({
          block: false,
        }));

        const session = (yield* agent.client.sendRpc("apps/create", {
          appId: "test-passthrough",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        const result = (yield* agent.client.sendRpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "hello" }],
        })) as {
          message: { parts: Array<{ type: string; text: string }> };
        };

        expect(result.message.parts[0]!.text).toBe("hello");
      }),
    );

    it.live("times out, blocks the message, and emits hookTimeout event", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("timeout-agent");

        registerTestApp(coreApp, "test-timeout", { hookTimeoutMs: 200 });

        coreApp.onBeforeMessageDelivery("test-timeout", async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return { block: true, reason: "Should never reach" };
        });

        const session = (yield* agent.client.sendRpc("apps/create", {
          appId: "test-timeout",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        // Fail-closed: timed-out hook blocks the send with HookBlocked.
        const result = yield* Effect.either(
          agent.client.sendRpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "should be blocked" }],
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left.message).toMatch(/timed out/i);
        }

        const timeoutEvent = yield* agent.client.waitForEvent(
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
      }),
    );

    it.live("passes through for non-app conversations", () =>
      Effect.gen(function* () {
        const alice = yield* registerAppAgent("alice-noapp");
        const bob = yield* registerAppAgent("bob-noapp");

        const conv = (yield* alice.client.sendRpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        })) as { conversation: { id: string } };

        const result = (yield* alice.client.sendRpc("messages/send", {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "normal DM" }],
        })) as {
          message: { parts: Array<{ type: string; text: string }> };
        };

        expect(result.message.parts[0]!.text).toBe("normal DM");
      }),
    );

    it.live("fails closed when hook throws", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("error-agent");

        registerTestApp(coreApp, "test-error");

        coreApp.onBeforeMessageDelivery("test-error", () => {
          throw new Error("Hook crashed!");
        });

        const session = (yield* agent.client.sendRpc("apps/create", {
          appId: "test-error",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        const result = yield* Effect.either(
          agent.client.sendRpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "should be blocked" }],
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left.message).toMatch(/hook error/i);
        }
      }),
    );

    it.live(
      "fails closed when hook returns a rejected promise (async throw)",
      () =>
        Effect.gen(function* () {
          const agent = yield* registerAppAgent("async-error-agent");

          registerTestApp(coreApp, "test-async-error");

          // Async throw path: the hook returns a rejected Promise rather than
          // throwing synchronously. `runHookWithTimeout` must route both through
          // the same fail-closed branch.
          coreApp.onBeforeMessageDelivery("test-async-error", async () => {
            return Promise.reject(new Error("async hook crash"));
          });

          const session = (yield* agent.client.sendRpc("apps/create", {
            appId: "test-async-error",
            invitedAgentIds: [],
          })) as {
            session: { id: string; conversations: Record<string, string> };
          };

          const convId = session.session.conversations["main"]!;

          const result = yield* Effect.either(
            agent.client.sendRpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "should be blocked" }],
            }),
          );
          expect(Either.isLeft(result)).toBe(true);
          if (Either.isLeft(result)) {
            expect(result.left.message).toMatch(/hook error/i);
          }
        }),
    );

    it.live("aborts the hook's AbortSignal on timeout", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("abort-timeout-agent");

        // Short timeout so the test finishes quickly; the hook sits idle on a
        // long sleep and polls its signal to confirm abort propagated.
        registerTestApp(coreApp, "test-abort-timeout", { hookTimeoutMs: 150 });

        let signalAborted = false;
        coreApp.onBeforeMessageDelivery("test-abort-timeout", async (ctx) => {
          // Wait past the timeout, then re-check the signal. The
          // AbortController lives inside `runHookWithTimeout` and must fire
          // when the timeout branch is taken.
          await new Promise((r) => setTimeout(r, 400));
          signalAborted = ctx.signal.aborted;
          return { block: false };
        });

        const session = (yield* agent.client.sendRpc("apps/create", {
          appId: "test-abort-timeout",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        const result = yield* Effect.either(
          agent.client.sendRpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "blocked-by-timeout" }],
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left.message).toMatch(/timed out/i);
        }

        // Give the delayed hook body time to finish its post-sleep read.
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));
        expect(signalAborted).toBe(true);
      }),
    );

    it.live("aborts the hook's AbortSignal when the hook throws", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("abort-throw-agent");

        registerTestApp(coreApp, "test-abort-throw");

        let capturedSignal: AbortSignal | null = null;
        coreApp.onBeforeMessageDelivery("test-abort-throw", (ctx) => {
          capturedSignal = ctx.signal;
          throw new Error("boom");
        });

        const session = (yield* agent.client.sendRpc("apps/create", {
          appId: "test-abort-throw",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        const result = yield* Effect.either(
          agent.client.sendRpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "blocked-by-throw" }],
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left.message).toMatch(/hook error/i);
        }

        // `runHookWithTimeout` aborts the controller synchronously in its
        // catch branch, so the signal the hook captured must be aborted by
        // the time we read it.
        expect(capturedSignal).not.toBeNull();
        expect((capturedSignal as unknown as AbortSignal).aborted).toBe(true);
      }),
    );

    it.live("block:true with explicit reason propagates unchanged", () =>
      Effect.gen(function* () {
        // Confirms `runBeforeMessageDelivery` does not rewrite an explicit
        // block reason from the hook (only synthesizes one on timeout/throw).
        const agent = yield* registerAppAgent("explicit-block-agent");

        registerTestApp(coreApp, "test-explicit-block");

        coreApp.onBeforeMessageDelivery("test-explicit-block", () => ({
          block: true,
          reason: "policy/no-secrets",
        }));

        const session = (yield* agent.client.sendRpc("apps/create", {
          appId: "test-explicit-block",
          invitedAgentIds: [],
        })) as {
          session: { id: string; conversations: Record<string, string> };
        };

        const convId = session.session.conversations["main"]!;

        const result = yield* Effect.either(
          agent.client.sendRpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "secret" }],
          }),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          const rpcErr = result.left as unknown as {
            code: number;
            message: string;
          };
          expect(rpcErr.code).toBe(ErrorCodes.HookBlocked);
          // The synthesized timeout/throw reasons include the phrases
          // "timed out" and "hook error"; an explicit reason must pass
          // through verbatim.
          expect(rpcErr.message).toContain("policy/no-secrets");
          expect(rpcErr.message).not.toMatch(/timed out/i);
          expect(rpcErr.message).not.toMatch(/hook error/i);
        }
      }),
    );
  });

  describe("on_join", () => {
    it.live("fires on_join when agent is admitted to session", () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("init-join");
        const invitee = yield* registerAppAgent("invitee-join");

        let joinFired = false;
        let joinCtx: {
          agent: { agentId: string };
          conversations: Record<string, string>;
        } | null = null;

        registerTestApp(coreApp, "test-join");

        coreApp.onAppJoin("test-join", (ctx) => {
          joinFired = true;
          joinCtx = ctx;
        });

        yield* initiator.client.sendRpc("apps/create", {
          appId: "test-join",
          invitedAgentIds: [invitee.agentId],
        });

        // Wait for async admission to complete
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));

        expect(joinFired).toBe(true);
        expect(joinCtx!.agent.agentId).toBe(invitee.agentId);
        expect(joinCtx!.conversations).toHaveProperty("main");
      }),
    );
  });
});
