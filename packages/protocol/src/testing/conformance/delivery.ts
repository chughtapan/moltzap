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
import { Effect, type Scope } from "effect";
import { makeTestClient, type TestClient } from "../test-client.js";
import { registerTestAgent, type TestAgent } from "../agent-registration.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  PropertyInvariantViolation,
  assertProperty,
  registerProperty,
} from "./registry.js";

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
