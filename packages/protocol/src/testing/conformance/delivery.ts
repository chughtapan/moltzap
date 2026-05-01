/**
 * Delivery — properties that exercise multi-connection invariants
 * against the real server: fan-out cardinality, store-and-replay,
 * payload opacity, and task-boundary isolation.
 *
 * Historical grouping note: spec #181 §5 calls this "Tier C". Code uses
 * semantic names only.
 *
 * Principle 3: every property body is `Effect<void, PropertyFailure>`.
 */
import * as fc from "fast-check";
import { Effect, Ref, type Scope } from "effect";
import { makeTestClient, type TestClient } from "../test-client.js";
import { registerTestAgent, type TestAgent } from "../agent-registration.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  PropertyDeferred,
  PropertyInvariantViolation,
  PropertyUnavailable,
  assertProperty,
  registerProperty,
} from "./registry.js";
import { sendUntypedRpc } from "./_helpers.js";

const CATEGORY = "delivery" as const;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CAPTURE_CAPACITY = 256;
const MAX_N = 4;

interface ConversationFixture {
  readonly owner: { agent: TestAgent; client: TestClient };
  readonly participants: ReadonlyArray<{
    agent: TestAgent;
    client: TestClient;
  }>;
  readonly conversationId: string;
}

function acquireClient(
  ctx: ConformanceRunContext,
  name: string,
): Effect.Effect<
  { agent: TestAgent; client: TestClient },
  string,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name,
    }).pipe(Effect.mapError((e) => `register(${name}): ${e.body}`));
    const client = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(Effect.mapError((e) => `makeTestClient(${name}): ${String(e)}`));
    return { agent, client };
  });
}

function acquireConversation(
  ctx: ConformanceRunContext,
  n: number,
  namePrefix: string,
): Effect.Effect<ConversationFixture, string, Scope.Scope> {
  const clamped = Math.min(Math.max(1, n), MAX_N);
  return Effect.gen(function* () {
    const owner = yield* acquireClient(ctx, `${namePrefix}-owner`);
    const participants = yield* Effect.forEach(
      Array.from({ length: clamped }, (_, i) => i),
      (i) => acquireClient(ctx, `${namePrefix}-p${i}`),
      { concurrency: clamped },
    );
    const createResult = yield* owner.client
      .sendRpc("conversations/create", {
        type: "group",
        name: `${namePrefix}-conv`,
        participants: participants.map((p) => ({
          type: "agent" as const,
          id: p.agent.agentId,
        })),
      })
      .pipe(Effect.either);
    if (createResult._tag === "Left") {
      return yield* Effect.fail(
        `conversations/create failed: ${createResult.left._tag}`,
      );
    }
    const created = createResult.right as {
      conversation?: { id?: string };
    };
    const conversationId = created.conversation?.id;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      return yield* Effect.fail(
        `conversations/create returned no conversation.id`,
      );
    }
    return { owner, participants, conversationId };
  });
}

/**
 * Fan-out cardinality — spec §5 C1: messages/send ⇒ **exactly** N
 * inbound events (one per connection). Architect §4.4: tightened from
 * `>=1` to `===1`; a server that duplicates events now fails.
 *
 * Empty-counts side channel replaced with an explicit
 * `PropertyInvariantViolation`.
 */
export function registerFanOutCardinality(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "fan-out-cardinality",
    "messages/send ⇒ exactly N inbound message events (one per connection)",
    assertProperty(CATEGORY, "fan-out-cardinality", () =>
      fc.assert(
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(fc.integer({ min: 2, max: 3 }), async (n) => {
          const result = await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const fixture = yield* acquireConversation(ctx, n, "fan").pipe(
                  Effect.mapError((e) => new Error(e)),
                );
                const send = yield* fixture.owner.client
                  .sendRpc("messages/send", {
                    conversationId: fixture.conversationId,
                    parts: [{ type: "text", text: "fan-out-ping" }],
                  })
                  .pipe(Effect.either);
                if (send._tag === "Left") {
                  return { kind: "send-failed" as const };
                }
                yield* Effect.sleep("250 millis");
                const observed = yield* Effect.forEach(
                  fixture.participants,
                  (p) => p.client.snapshot,
                );
                const counts = observed.map(
                  (snap) =>
                    snap.filter(
                      (s) =>
                        s.kind === "inbound" &&
                        s.frame?.type === "event" &&
                        typeof s.frame.event === "string" &&
                        s.frame.event.includes("message"),
                    ).length,
                );
                return { kind: "ok" as const, counts };
              }),
            ),
          );
          if (result.kind !== "ok") return false;
          // Exact-cardinality predicate. Duplicates and drops both fail.
          return (
            result.counts.length === fixture_n(n) &&
            result.counts.every((c) => c === 1)
          );
        }),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 3 },
      ),
    ),
  );
}

function fixture_n(requested: number): number {
  return Math.min(Math.max(1, requested), MAX_N);
}

/**
 * Store-and-replay — spec §5 C2: offline-then-reconnect delivers the
 * messages sent during the disconnect window.
 *
 * **Status: architect §4.5 option (b) — property split.**
 *
 * Option (a) (reconnect via scope composition) was attempted and is
 * infrastructure-viable: TestClient supports re-opening with the same
 * apiKey/agentId via `Effect.scoped`, no new public primitive needed.
 * However, the current server implementation does not buffer events
 * for offline subscribers (empirical observation against
 * `startCoreTestServer` at commit time): after reconnect, the
 * participant's capture buffer contains zero of the N messages sent
 * during the offline window. This is a server-side gap against spec
 * §5 C2, not a TestClient gap.
 *
 * Per architect §4.5 option (b), this property is scoped to
 * **basic-delivery-landing** — the weaker invariant that N messages
 * sent to a live conversation land in every currently-subscribed
 * participant's capture buffer. The full offline-replay assertion is
 * tracked as a follow-up under epic #186. If/when the server
 * implements C2 replay, flip this body back to the reconnect form
 * from the git history and remove the #186 pointer.
 */
export function registerStoreAndReplay(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "store-and-replay",
    "every messages/send lands in a live participant's capture buffer (basic-delivery-landing; #186 tracks C2 offline-replay)",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireConversation(ctx, 1, "sr").pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "store-and-replay",
                reason: `fixture: ${e}`,
              }),
          ),
        );
        const participant = fixture.participants[0];
        if (participant === undefined) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "store-and-replay",
              reason: "fixture missing participant",
            }),
          );
        }
        const sent = 3;
        for (let i = 0; i < sent; i++) {
          yield* fixture.owner.client
            .sendRpc("messages/send", {
              conversationId: fixture.conversationId,
              parts: [{ type: "text", text: `sr-${i}` }],
            })
            .pipe(Effect.either);
        }
        yield* Effect.sleep("350 millis");
        const snap = yield* participant.client.snapshot;
        const delivered = snap.filter(
          (s) =>
            s.kind === "inbound" &&
            s.frame?.type === "event" &&
            typeof s.frame.event === "string" &&
            s.frame.event.includes("message"),
        ).length;
        if (delivered < sent) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "store-and-replay",
              reason: `sent ${sent}, live participant observed ${delivered}`,
            }),
          );
        }
      }),
    ),
  );
}

/** Payload opacity — sent text appears byte-for-byte in delivered events. */
export function registerPayloadOpacity(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "payload-opacity",
    "sent message text appears verbatim in delivered event bytes",
    assertProperty(CATEGORY, "payload-opacity", () =>
      fc.assert(
        // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
        fc.asyncProperty(
          // Exclude JSON-meta chars so a simple substring match is valid.
          fc
            .string({ minLength: 4, maxLength: 24 })
            .filter((s) => !/[\\" \n\r\t]/.test(s)),
          // #ignore-sloppy-code-next-line[async-keyword]: fast-check asyncProperty contract requires Promise-returning callback
          async (text) => {
            const found = await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const fixture = yield* acquireConversation(ctx, 1, "po").pipe(
                    Effect.mapError((e) => new Error(e)),
                  );
                  const participant = fixture.participants[0];
                  if (participant === undefined) return false;
                  yield* fixture.owner.client
                    .sendRpc("messages/send", {
                      conversationId: fixture.conversationId,
                      parts: [{ type: "text", text }],
                    })
                    .pipe(Effect.either);
                  yield* Effect.sleep("250 millis");
                  const snap = yield* participant.client.snapshot;
                  return snap.some(
                    (s) =>
                      s.kind === "inbound" &&
                      s.frame?.type === "event" &&
                      s.raw.includes(text),
                  );
                }),
              ),
            ).catch(() => false);
            return found;
          },
        ),
        { seed: ctx.seed, numRuns: ctx.opts.numRuns ?? 3 },
      ),
    ),
  );
}

/**
 * Hook-gated delivery — admission verbs are awaitable, the verdict
 * mutates the recipient view, dynamically attached conversations enter
 * the hook pipeline (mirrors `33-attach-conversation.integration.test.ts:312-369`).
 *
 * Architect plan §1.7 acceptance:
 *   - `before_message_delivery: { block: true }` drops the message before
 *     delivery (recipient does NOT observe it).
 *   - `block: false, patch: { parts: [...] }` lands a MUTATED message —
 *     recipient sees the patched parts, not the sender's parts.
 *   - `apps/attachConversation` adds a conversation to the session's
 *     hook pipeline; the same hook then fires for traffic on the new
 *     conversation.
 *
 * Conformance reach: the assertions are observable on the SENDER (deny
 * → typed dispatch error) and RECIPIENT (patched parts in inbound
 * event). Wiring the app session over WS requires `apps/create`, which
 * needs the initiator's `owner_user_id` to be non-null — see the
 * `app-disconnect-fail-policy` rationale in `boundary.ts`. When the
 * fixture's agents are owner-less (default `startCoreTestServer`), the
 * property reports `PropertyUnavailable` and B.9 carries the load.
 */
export function registerHookGatedDelivery(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "hook-gated-delivery",
    "deny drops; patch mutates recipient view; attached conv enters hooks",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireAppSessionFixture(
          ctx,
          "hgd",
          "hook-gated-delivery",
        ).pipe(Effect.either);
        if (fixture._tag === "Left") {
          return yield* Effect.fail(fixture.left);
        }
        // Codex review (#327, finding 4): the protocol fixture cannot
        // drive the deny/patch/attach scenarios end-to-end (no DB seam
        // to inspect the recipient view; `apps/attachConversation` is a
        // c2s RPC but the assertion needs a server-internal observation
        // the conformance contract does not expose). When a future
        // fixture extension makes apps/create reachable, surface a
        // typed Deferred so the suite reports honest coverage instead
        // of a vacuous pass.
        return yield* Effect.fail(
          new PropertyDeferred({
            category: CATEGORY,
            name: "hook-gated-delivery",
            followUp:
              "deny/patch/attach assertions live in B.9 server integration tests (#318) — protocol fixture lacks DB-level recipient inspection",
          }),
        );
      }),
    ),
  );
}

/**
 * Multi-app FIFO short-circuit — register two apps on the same hook,
 * first denies, assert second handler is NOT invoked. Architect plan
 * §3.4: `Effect.forEach(registeredApps, ...)` iterates in registration
 * order; first-deny short-circuits the loop.
 *
 * Same fixture constraint as `hook-gated-delivery`: requires app session
 * machinery. Reports `PropertyUnavailable` when prerequisites are
 * absent.
 */
export function registerMultiAppFifoShortCircuit(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "multi-app-fifo-short-circuit",
    "two apps; first denies; second hook is NOT invoked",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireAppSessionFixture(
          ctx,
          "mfs",
          "multi-app-fifo-short-circuit",
        ).pipe(Effect.either);
        if (fixture._tag === "Left") {
          return yield* Effect.fail(fixture.left);
        }
        // Codex review (#327, finding 5): once apps/create succeeds, the
        // FIFO short-circuit assertion requires registering a SECOND
        // app on the same hook and observing the second handler is NOT
        // invoked — the protocol fixture exposes a single-app session.
        // B.9 covers via the dual-app wire fixture; surface a typed
        // Deferred here.
        return yield* Effect.fail(
          new PropertyDeferred({
            category: CATEGORY,
            name: "multi-app-fifo-short-circuit",
            followUp:
              "two-app dispatch + first-deny short-circuit assertion lives in B.9 server integration tests (#318)",
          }),
        );
      }),
    ),
  );
}

/**
 * App-session fixture — registers an app via WS, opens a session as a
 * sender, returns the live clients ready for hook-gated assertions.
 * Returns `PropertyUnavailable` when the prerequisite chain (agent
 * `owner_user_id` on the sender) cannot be satisfied through the
 * fixture's HTTP register endpoint. Callers pattern-match Left to
 * surface the typed unavailability.
 */
interface AppSessionFixture {
  readonly app: { agent: TestAgent; client: TestClient; appId: string };
  readonly sender: { agent: TestAgent; client: TestClient };
  readonly sessionId: string;
  readonly dispatchHits: Ref.Ref<number>;
}

function acquireAppSessionFixture(
  ctx: ConformanceRunContext,
  namePrefix: string,
  propertyName: string,
): Effect.Effect<AppSessionFixture, PropertyUnavailable, Scope.Scope> {
  const unavailable = (reason: string): PropertyUnavailable =>
    new PropertyUnavailable({ category: CATEGORY, name: propertyName, reason });
  return Effect.gen(function* () {
    const appAgent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: `${namePrefix}-app`,
    }).pipe(
      Effect.mapError((e) => unavailable(`app agent register: ${e.body}`)),
    );
    const appClient = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: appAgent.apiKey,
      agentId: appAgent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) => unavailable(`app client acquire: ${String(e)}`)),
    );

    const appId = `${namePrefix}-${Date.now().toString(36)}`;
    const registerOutcome = yield* sendUntypedRpc(appClient, "apps/register", {
      manifest: {
        appId,
        name: `Hook-gated app ${appId}`,
        permissions: { required: [], optional: [] },
        conversations: [
          { key: "main", name: "Main", participantFilter: "all" },
        ],
        hooks: {
          before_message_delivery: { timeout_ms: 5000 },
          on_join: {},
        },
      },
    }).pipe(Effect.either);
    if (registerOutcome._tag === "Left") {
      return yield* Effect.fail(
        unavailable(`apps/register failed: ${registerOutcome.left._tag}`),
      );
    }

    const senderAgent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: `${namePrefix}-sender`,
    }).pipe(Effect.mapError((e) => unavailable(`sender register: ${e.body}`)));
    const senderClient = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: senderAgent.apiKey,
      agentId: senderAgent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        unavailable(`sender client acquire: ${String(e)}`),
      ),
    );

    const createOutcome = yield* senderClient
      .sendRpc("apps/create", { appId, invitedAgentIds: [] })
      .pipe(Effect.either);
    if (createOutcome._tag === "Left") {
      // Most common cause: owner_user_id is null on the sender (see
      // app-host.ts:629). The default `startCoreTestServer` does not
      // configure `devModeUserId`; B.9 fills the gap via DB seeding.
      return yield* Effect.fail(
        unavailable(
          `apps/create failed (likely sender owner_user_id null; B.9 covers via DB seeding): ${createOutcome.left._tag}`,
        ),
      );
    }

    const session = (createOutcome.right as { session?: { id?: string } })
      .session;
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return yield* Effect.fail(
        unavailable(`apps/create returned no session.id`),
      );
    }

    const dispatchHits = yield* Ref.make(0);
    return {
      app: { agent: appAgent, client: appClient, appId },
      sender: { agent: senderAgent, client: senderClient },
      sessionId,
      dispatchHits,
    } satisfies AppSessionFixture;
  });
}

/** Task-boundary isolation — conversation A's events don't leak into B. */
export function registerTaskBoundaryIsolation(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "task-boundary-isolation",
    "participants in conversation B observe zero leaks from conversation A",
    Effect.scoped(
      Effect.gen(function* () {
        const fxA = yield* acquireConversation(ctx, 1, "iso-a").pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "task-boundary-isolation",
                reason: `fixture A: ${e}`,
              }),
          ),
        );
        const fxB = yield* acquireConversation(ctx, 1, "iso-b").pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: "task-boundary-isolation",
                reason: `fixture B: ${e}`,
              }),
          ),
        );
        yield* fxA.owner.client
          .sendRpc("messages/send", {
            conversationId: fxA.conversationId,
            parts: [{ type: "text", text: "iso-leak-canary" }],
          })
          .pipe(Effect.either);
        yield* Effect.sleep("250 millis");
        const outsider = fxB.participants[0];
        if (outsider === undefined) return;
        const snap = yield* outsider.client.snapshot;
        const leaked = snap.some(
          (s) => s.kind === "inbound" && s.raw.includes(fxA.conversationId),
        );
        if (leaked) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "task-boundary-isolation",
              reason: `conversation ${fxA.conversationId} leaked into outsider ${outsider.agent.agentId}`,
            }),
          );
        }
      }),
    ),
  );
}
