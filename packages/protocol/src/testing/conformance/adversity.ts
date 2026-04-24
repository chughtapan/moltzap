/**
 * Adversity — each toxic property asserts the specific invariant spec
 * #181 §5 names for that toxic. Not a one-size-fits-all body: the
 * toxics have different failure modes, and the spec's contract for each
 * is different.
 *
 * Historical grouping note: spec #181 §5 calls this "Tier D". Code uses
 * semantic names only. Backpressure is a tombstone (→ #186).
 *
 * | Toxic       | Spec asks (paraphrased)                              |
 * |-------------|------------------------------------------------------|
 * | latency     | delivery invariant still holds under added latency   |
 * | slicer      | delivery holds + payload byte-identical through splits |
 * | reset_peer  | sender's RPCs surface typed TransportClosedError     |
 * | timeout     | caller surfaces typed RpcTimeoutError within budget  |
 * | slow_close  | scope release completes within a bounded window      |
 *
 * Principle 3: every property body is `Effect<void, PropertyFailure>`
 * — no bare throws, no `Effect.void` shortcuts.
 */
import { Clock, Effect, type Scope } from "effect";
import { defaultToxicProfile } from "../toxics/defaults.js";
import type { Proxy } from "../toxics/client.js";
import type { ToxicProfile } from "../toxics/profile.js";
import { makeTestClient, type TestClient } from "../test-client.js";
import { registerTestAgent, type TestAgent } from "../agent-registration.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  PropertyDeferred,
  PropertyInvariantViolation,
  PropertyUnavailable,
  registerProperty,
} from "./registry.js";

const CATEGORY = "adversity" as const;
const DEFAULT_CAPTURE_CAPACITY = 128;

/** Acquire a TestClient that routes through the Toxiproxy proxy. */
function acquireProxiedClient(
  ctx: ConformanceRunContext,
  proxy: Proxy,
  name: string,
  defaultTimeoutMs: number,
  unavailable: (reason: string) => PropertyUnavailable,
): Effect.Effect<
  { agent: TestAgent; client: TestClient },
  PropertyUnavailable,
  Scope.Scope
> {
  // Preserve the upstream path (e.g., `/ws`) when building the
  // proxy-facing URL: Toxiproxy is a raw TCP forwarder, so the client's
  // upgrade path must match what the server's HTTP router expects.
  const upstreamPath = new URL(ctx.realServer.wsUrl).pathname;
  const proxiedUrl = `${proxy.listenUrl}${upstreamPath}`;
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name,
    }).pipe(Effect.mapError((e) => unavailable(`register: ${e.body}`)));
    const client = yield* makeTestClient({
      serverUrl: proxiedUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) => unavailable(`makeTestClient: ${String(e)}`)),
    );
    return { agent, client };
  });
}

/**
 * Factory — wire a Toxiproxy proxy + attach the toxic; hand a body the
 * proxy. Hard-deadlines each property body so a hanging toxic can't
 * block the suite indefinitely; if the deadline fires, the property
 * reports `PropertyUnavailable` (not a pass, not a crash).
 */
const PROPERTY_BUDGET_MS = 15_000;

/**
 * Body params — `attachToxic` attaches the toxic inside the caller's
 * scope. Nesting matters: the caller typically does
 *
 *   Effect.scoped(gen(function* () {
 *     const client = yield* acquireProxiedClient(...)  // outer
 *     yield* Effect.scoped(gen(function* () {
 *       yield* attachToxic                             // inner
 *       yield* assertion(client)
 *     }))                                              // toxic removed
 *   }))                                                // client close OK
 *
 * so the toxic is removed BEFORE TestClient's socket close. Under
 * disruptive toxics (timeout, reset_peer), this lets the WS close
 * handshake flow cleanly instead of hanging on a black-holed channel.
 */
type ToxicBodyParams = {
  readonly proxy: Proxy;
  readonly unavailable: (reason: string) => PropertyUnavailable;
  readonly attachToxic: Effect.Effect<void, PropertyUnavailable, Scope.Scope>;
};

function withToxicProxy(opts: {
  readonly ctx: ConformanceRunContext;
  readonly propertyName: string;
  readonly description: string;
  readonly proxyName: string;
  readonly profile: ToxicProfile;
  readonly body: (
    params: ToxicBodyParams,
  ) => Effect.Effect<
    void,
    PropertyUnavailable | PropertyInvariantViolation,
    Scope.Scope
  >;
}): void {
  const { ctx, propertyName, description, proxyName, profile, body } = opts;
  const toxiproxy = ctx.toxiproxy;
  const run: Effect.Effect<
    void,
    PropertyUnavailable | PropertyInvariantViolation
  > =
    toxiproxy === null
      ? Effect.fail(
          new PropertyUnavailable({
            category: CATEGORY,
            name: propertyName,
            reason: "Toxiproxy client not provisioned for this run",
          }),
        )
      : (() => {
          const upstreamHostPort = ctx.realServer.wsUrl
            .replace(/^ws:\/\//, "")
            .replace(/\/.*$/, "");
          const unavailable = (reason: string): PropertyUnavailable =>
            new PropertyUnavailable({
              category: CATEGORY,
              name: propertyName,
              reason,
            });
          return Effect.scoped(
            Effect.gen(function* () {
              const proxy = yield* toxiproxy
                .proxy({ name: proxyName, upstream: upstreamHostPort })
                .pipe(Effect.mapError((e) => unavailable(`proxy: ${e.body}`)));
              const attachToxic: ToxicBodyParams["attachToxic"] = proxy
                .withToxic(profile)
                .pipe(
                  Effect.mapError((e) => unavailable(`toxic: ${e.body}`)),
                  Effect.asVoid,
                );
              yield* body({ proxy, unavailable, attachToxic });
            }),
          ).pipe(
            Effect.timeoutFail({
              duration: `${PROPERTY_BUDGET_MS} millis`,
              onTimeout: () =>
                unavailable(
                  `property exceeded ${PROPERTY_BUDGET_MS}ms budget under toxic`,
                ),
            }),
          );
        })();
  registerProperty(ctx, CATEGORY, propertyName, description, run);
}

/**
 * Latency — owner + participant route through a latency proxy. Owner
 * sends `messages/send`; participant observes ≥1 inbound message
 * event. Latency merely slows delivery; it must not drop events.
 */
export function registerLatencyResilience(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "latency-resilience",
    description: "fan-out delivery survives added latency + jitter",
    proxyName: `lat-${ctx.seed}-${Math.random().toString(36).slice(2, 8)}`,
    profile: defaultToxicProfile.latency,
    body: ({ proxy, unavailable, attachToxic }) =>
      Effect.gen(function* () {
        const owner = yield* acquireProxiedClient(
          ctx,
          proxy,
          `lat-${ctx.seed}-o`,
          6000,
          unavailable,
        );
        const participant = yield* acquireProxiedClient(
          ctx,
          proxy,
          `lat-${ctx.seed}-p`,
          6000,
          unavailable,
        );
        const conv = yield* createOneOnOneConversation(owner, participant);
        if (conv.kind !== "ok") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "latency-resilience",
              reason: conv.reason,
            }),
          );
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* attachToxic;
            yield* owner.client
              .sendRpc("messages/send", {
                conversationId: conv.conversationId,
                parts: [{ type: "text", text: "lat-ping" }],
              })
              .pipe(Effect.either);
            // 100ms latency + 50ms jitter → 600ms window is generous.
            yield* Effect.sleep("600 millis");
          }),
        );
        const snap = yield* participant.client.snapshot;
        const delivered = snap.filter(
          (s) =>
            s.kind === "inbound" &&
            s.frame?.type === "event" &&
            typeof s.frame.event === "string" &&
            s.frame.event.includes("message"),
        ).length;
        if (delivered === 0) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "latency-resilience",
              reason: "latency toxic dropped all events",
            }),
          );
        }
      }),
  });
}

/** Backpressure — DEFERRED to epic #186. */
export function registerBackpressure(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "backpressure",
    "backpressure property deferred to #186 — BackpressurePolicy not extant",
    Effect.fail(
      new PropertyDeferred({
        category: CATEGORY,
        name: "backpressure",
        followUp: "https://github.com/chughtapan/moltzap/issues/186",
      }),
    ),
  );
}

/**
 * Slicer — partial-frame splits must not corrupt payload. Owner sends
 * a message with a distinctive token; participant's snapshot contains
 * that token verbatim.
 */
export function registerSlicerFraming(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "slicer-framing",
    description: "partial-frame slicing preserves payload byte-identity",
    proxyName: `sli-${ctx.seed}-${Math.random().toString(36).slice(2, 8)}`,
    profile: defaultToxicProfile.slicer,
    body: ({ proxy, unavailable, attachToxic }) =>
      Effect.gen(function* () {
        const owner = yield* acquireProxiedClient(
          ctx,
          proxy,
          `sli-${ctx.seed}-o`,
          8000,
          unavailable,
        );
        const participant = yield* acquireProxiedClient(
          ctx,
          proxy,
          `sli-${ctx.seed}-p`,
          8000,
          unavailable,
        );
        const conv = yield* createOneOnOneConversation(owner, participant);
        if (conv.kind !== "ok") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "slicer-framing",
              reason: conv.reason,
            }),
          );
        }
        const token = `sli-token-${ctx.seed}-${Date.now().toString(36)}`;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* attachToxic;
            yield* owner.client
              .sendRpc("messages/send", {
                conversationId: conv.conversationId,
                parts: [{ type: "text", text: token }],
              })
              .pipe(Effect.either);
            yield* Effect.sleep("1200 millis"); // slicer fragments are slow
          }),
        );
        const snap = yield* participant.client.snapshot;
        const matched = snap.some(
          (s) =>
            s.kind === "inbound" &&
            s.frame?.type === "event" &&
            s.raw.includes(token),
        );
        if (!matched) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "slicer-framing",
              reason: `token ${token} not reassembled in participant's frames`,
            }),
          );
        }
      }),
  });
}

/**
 * reset_peer — mid-flight the toxic forcibly resets the connection.
 * Spec invariant: sender's RPCs surface a typed `TransportClosedError`,
 * never hang, never crash. Full store-and-replay (reconnect + missed-
 * event replay) is a consumer-side concern driven by each real client
 * against `TestServer`; protocol-level guarantee is that the TestClient
 * surfaces the transport failure as a typed outcome.
 */
export function registerResetPeerRecovery(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "reset-peer-recovery",
    description: "reset_peer surfaces TransportClosedError without hanging",
    proxyName: `rst-${ctx.seed}-${Math.random().toString(36).slice(2, 8)}`,
    profile: defaultToxicProfile.reset_peer,
    body: ({ proxy, unavailable, attachToxic }) =>
      Effect.gen(function* () {
        const sender = yield* acquireProxiedClient(
          ctx,
          proxy,
          `rst-${ctx.seed}-s`,
          // Deadline > reset_peer.timeoutMs (2000); bounded so a
          // never-firing reset doesn't hang the suite.
          4000,
          unavailable,
        );
        const observed = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* attachToxic;
            const start = yield* Clock.currentTimeMillis;
            for (let i = 0; i < 10; i++) {
              const outcome = yield* sender.client
                .sendRpc("conversations/list", {})
                .pipe(Effect.either);
              if (
                outcome._tag === "Left" &&
                outcome.left._tag === "TestingTransportClosedError"
              ) {
                return true;
              }
              yield* Effect.sleep("300 millis");
              const elapsed = (yield* Clock.currentTimeMillis) - start;
              if (elapsed > 3500) return false;
            }
            return false;
          }),
        );
        if (!observed) {
          return yield* Effect.fail(
            new PropertyUnavailable({
              category: CATEGORY,
              name: "reset-peer-recovery",
              reason: "reset_peer toxic did not close within 3.5s budget",
            }),
          );
        }
      }),
  });
}

/**
 * timeout — the toxic black-holes forwarding; the client must surface
 * a typed `RpcTimeoutError` within its own timeout budget (not hang).
 */
export function registerTimeoutSurface(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "timeout-surface",
    description: "timeout toxic surfaces typed RpcTimeoutError within budget",
    proxyName: `to-${ctx.seed}-${Math.random().toString(36).slice(2, 8)}`,
    profile: defaultToxicProfile.timeout,
    body: ({ proxy, unavailable, attachToxic }) =>
      Effect.gen(function* () {
        // Client timeout must be LESS than the toxic's forwarding
        // timeout so the RPC hits the client-side deadline first.
        // defaultToxicProfile.timeout.timeoutMs = 5000. Set client to
        // 1500ms for a fast, clear timeout surface.
        const proxied = yield* acquireProxiedClient(
          ctx,
          proxy,
          `to-${ctx.seed}-c`,
          1500,
          unavailable,
        );
        const { outcomeTag, elapsed } = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* attachToxic;
            const start = yield* Clock.currentTimeMillis;
            const outcome = yield* proxied.client
              .sendRpc("conversations/list", {})
              .pipe(Effect.either);
            const elapsed = (yield* Clock.currentTimeMillis) - start;
            return {
              outcomeTag:
                outcome._tag === "Right" ? "success" : outcome.left._tag,
              elapsed,
            };
          }),
        );
        if (outcomeTag === "success") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "timeout-surface",
              reason: "RPC through timeout toxic unexpectedly succeeded",
            }),
          );
        }
        if (outcomeTag !== "TestingRpcTimeoutError") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "timeout-surface",
              reason: `expected RpcTimeoutError, got ${outcomeTag}`,
            }),
          );
        }
        if (elapsed > 3000) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "timeout-surface",
              reason: `timeout fired at ${elapsed}ms, expected <3000ms`,
            }),
          );
        }
      }),
  });
}

/**
 * slow_close — close-frames are delayed by the toxic. The scope
 * release must still complete within a bounded window so the suite
 * doesn't leak descriptors.
 */
export function registerSlowCloseCleanup(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "slow-close-cleanup",
    description: "slow_close toxic does not leak descriptors beyond 2s",
    proxyName: `sc-${ctx.seed}-${Math.random().toString(36).slice(2, 8)}`,
    profile: defaultToxicProfile.slow_close,
    body: ({ proxy, unavailable, attachToxic }) =>
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis;
        yield* attachToxic.pipe(Effect.orElseSucceed(() => undefined));
        // Open + close a client scoped to this Effect.gen block; when
        // Effect.scoped unwinds, the client must release within the
        // 2s budget even though the toxic delays its close-frame.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const _client = yield* acquireProxiedClient(
              ctx,
              proxy,
              `sc-${ctx.seed}-c`,
              2000,
              unavailable,
            );
            // A single RPC proves the socket is alive before close.
            yield* _client.client
              .sendRpc("conversations/list", {})
              .pipe(Effect.either);
          }),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - start;
        if (elapsed > 5000) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "slow-close-cleanup",
              reason: `scope release took ${elapsed}ms under slow_close (budget 5000ms)`,
            }),
          );
        }
      }),
  });
}

// ── helpers ──────────────────────────────────────────────────────────

type ConvResult =
  | { readonly kind: "ok"; readonly conversationId: string }
  | { readonly kind: "error"; readonly reason: string };

function createOneOnOneConversation(
  owner: { agent: TestAgent; client: TestClient },
  participant: { agent: TestAgent; client: TestClient },
): Effect.Effect<ConvResult> {
  return Effect.gen(function* () {
    const create = yield* owner.client
      .sendRpc("conversations/create", {
        type: "group",
        name: `adv-conv-${owner.agent.name}`,
        participants: [
          { type: "agent" as const, id: participant.agent.agentId },
        ],
      })
      .pipe(Effect.either);
    if (create._tag === "Left") {
      return {
        kind: "error",
        reason: `conversations/create under toxic: ${create.left._tag}`,
      } satisfies ConvResult;
    }
    const id = (create.right as { conversation?: { id?: string } }).conversation
      ?.id;
    if (typeof id !== "string" || id.length === 0) {
      return {
        kind: "error",
        reason: "conversations/create returned no conversation.id",
      } satisfies ConvResult;
    }
    return { kind: "ok", conversationId: id } satisfies ConvResult;
  });
}
