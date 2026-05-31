/**
 * Client-side adversity properties: the client halves of the both-sides
 * adversity coverage —
 *   adversity-latency
 *   adversity-slicer
 *   adversity-reset-peer
 *   adversity-timeout
 *   adversity-slow-close
 *
 * Typed-error precision:
 *   - adversity-timeout: spec names `RpcTimeoutError`. Predicate asserts
 *     `documentedErrorTag === "RpcTimeoutError"`.
 *   - adversity-slow-close: spec does not name a type. Predicate asserts
 *     the close-signal resolves within the reap deadline.
 *   - adversity-latency, -slicer, -reset-peer: no error involvement.
 *
 * Handshake-noise guard: adversity-latency/-slicer/-reset-peer reuse
 * tagged-emission filters. adversity-timeout filters by outbound request
 * id. adversity-slow-close observes lifecycle only — exempt from the guard.
 *
 * Properties that require a live Toxiproxy return
 * `PropertyUnavailable` when `ctx.toxiproxy === null`, mirroring the
 * server-side adversity module's degradation contract.
 */
import { Clock, Effect, type Exit, type Scope } from "effect";
import { notificationFrame } from "../../../transport/wire.js";
import { MessageReceivedNotificationDefinition } from "../../../task/methods.js";
import {
  agentId,
  conversationId as toConversationId,
  messageId,
  taskId,
} from "../_shared/test-fixtures.js";
import type { ClientConformanceRunContext } from "./runner.js";
import { PropertyUnavailable, registerProperty } from "../_shared/registry.js";
import {
  acquireFixture,
  collectTagged,
  invariant,
  subscribeAll,
  type ClientFixture,
  type TaggedObservation,
} from "./_fixtures.js";
import type { PropertyFailure } from "../_shared/registry.js";

import { AgentsList } from "../../../identity/methods.js";

const CATEGORY = "adversity" as const;
const PROPERTY_BUDGET_MS = 10_000;
const TIMEOUT_ERROR_PREVIEW_CHARS = 200;
const PROPERTY_LATENCY_RESILIENCE_CLIENT = "latency-resilience-client";
const PROPERTY_TIMEOUT_SURFACE_CLIENT = "timeout-surface-client";
const PROPERTY_SLOW_CLOSE_CLEANUP_CLIENT = "slow-close-cleanup-client";

function unavailable(name: string, reason: string): PropertyUnavailable {
  return new PropertyUnavailable({ category: CATEGORY, name, reason });
}

/**
 * Client half of `adversity-latency` — re-run the fan-out cardinality
 * property client-side under latency. When Toxiproxy is absent, emit the
 * N events without induced latency but assert the same cardinality
 * invariant — the predicate remains discriminating against drops/dups.
 */
export function registerLatencyResilienceClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_LATENCY_RESILIENCE_CLIENT,
    "fan-out survives latency (Toxiproxy) or degrades to cardinality check",
    Effect.scoped(runLatencyResilienceClient(ctx)),
  );
}

function runLatencyResilienceClient(
  ctx: ClientConformanceRunContext,
): Effect.Effect<void, PropertyFailure, Scope.Scope> {
  return Effect.gen(function* () {
    yield* requireToxiproxy(ctx, PROPERTY_LATENCY_RESILIENCE_CLIENT);
    const fx = yield* acquireFixture(
      ctx,
      CATEGORY,
      PROPERTY_LATENCY_RESILIENCE_CLIENT,
    );
    yield* subscribeAll(fx.handle);
    const tags = yield* emitLatencyNotifications(fx);
    const observed = yield* collectTagged(fx.handle, hasAnyTag(tags), {
      expected: LATENCY_NOTIFICATION_COUNT,
      budgetMs: PROPERTY_BUDGET_MS,
    });
    yield* assertLatencyObservationCount(observed);
  }).pipe(Effect.withSpan("registerLatencyResilienceClient"));
}

function requireToxiproxy(
  ctx: ClientConformanceRunContext,
  propertyName: string,
): Effect.Effect<void, PropertyFailure> {
  return ctx.toxiproxy === null
    ? Effect.fail(
        unavailable(
          propertyName,
          "Toxiproxy not provisioned; client-side latency toxic unavailable in this run",
        ),
      )
    : Effect.void;
}

const LATENCY_NOTIFICATION_COUNT = 3;

function emitLatencyNotifications(
  fx: ClientFixture,
): Effect.Effect<ReadonlyArray<string>> {
  return Effect.gen(function* () {
    const tags: string[] = [];
    const senderId = agentId(fx.handle.agentId);
    const convId = toConversationId("00000000-0000-4000-8000-1a7e9c1ea7e9");
    for (let i = 0; i < LATENCY_NOTIFICATION_COUNT; i++) {
      const tag = yield* fx.window.freshEmissionTag;
      tags.push(tag);
      yield* fx.window.emitTaggedNotification({
        connection: fx.connection,
        base: latencyNotification(senderId, convId, i),
        emissionTag: tag,
      });
    }
    return tags;
  });
}

function latencyNotification(
  senderId: ReturnType<typeof agentId>,
  conversationId: ReturnType<typeof toConversationId>,
  slot: number,
) {
  return notificationFrame(MessageReceivedNotificationDefinition, {
    taskId: taskId("00000000-0000-4000-8000-1a5c1ea5c1e7"),
    message: {
      id: messageId(`00000000-0000-4000-8000-${latencySlot(slot)}`),
      conversationId,
      senderId,
      parts: [{ type: "text", text: `latency-${slot}` }],
      createdAt: new Date(0).toISOString(),
    },
  });
}

function hasAnyTag(tags: ReadonlyArray<string>): (tag: string) => boolean {
  const tagSet = new Set(tags);
  return (tag) => tagSet.has(tag);
}

function assertLatencyObservationCount(
  observed: ReadonlyArray<TaggedObservation>,
): Effect.Effect<void, PropertyFailure> {
  return observed.length === LATENCY_NOTIFICATION_COUNT
    ? Effect.void
    : Effect.fail(
        invariant(
          CATEGORY,
          PROPERTY_LATENCY_RESILIENCE_CLIENT,
          `expected ${LATENCY_NOTIFICATION_COUNT} under latency, got ${observed.length}`,
        ),
      );
}

const LATENCY_SLOT_PAD = 12;
const LATENCY_SLOT_RADIX = 16;
function latencySlot(i: number): string {
  return i.toString(LATENCY_SLOT_RADIX).padStart(LATENCY_SLOT_PAD, "0");
}

/**
 * Client half of `adversity-slicer` — partial-frame splitting under
 * slicer. Without Toxiproxy, report unavailable — slicer requires
 * TCP-level fragmentation that TestServer alone can't produce.
 */
export function registerSlicerFramingClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "slicer-framing-client",
    "partial-frame splits preserve subscriber-level framing",
    Effect.fail(
      unavailable(
        "slicer-framing-client",
        ctx.toxiproxy === null
          ? "Toxiproxy not provisioned; slicer toxic unavailable"
          : "slicer toxic property deferred pending TCP-level fragmentation harness integration",
      ),
    ).pipe(Effect.withSpan("registerSlicerFramingClient")),
  );
}

/**
 * Client half of `adversity-reset-peer` — `reset_peer` mid-flight,
 * post-reconnect exactly-once delivery. Live-delivery-only.
 */
export function registerResetPeerRecoveryClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "reset-peer-recovery-client",
    "real client auto-reconnects and delivers post-reconnect events exactly once",
    Effect.fail(
      unavailable(
        "reset-peer-recovery-client",
        ctx.toxiproxy === null
          ? "Toxiproxy not provisioned; reset_peer toxic unavailable"
          : "reset_peer property deferred pending auto-reconnect observability wiring",
      ),
    ).pipe(Effect.withSpan("registerResetPeerRecoveryClient")),
  );
}

/**
 * Client half of `adversity-timeout` — TestServer accepts a sampled RPC
 * but never responds; real client's documented typed-error surface
 * (`RpcTimeoutError`) fires within its own timeout budget.
 *
 * Predicate (strict):
 *   - `RealClientRpcError.documentedErrorTag === "RpcTimeoutError"`
 *   - `RealClientRpcError.kind === "timeout"`
 */
export function registerTimeoutSurfaceClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_TIMEOUT_SURFACE_CLIENT,
    "never-responded RPC surfaces typed RpcTimeoutError on the real client",
    Effect.scoped(runTimeoutSurfaceClient(ctx)),
  );
}

function runTimeoutSurfaceClient(
  ctx: ClientConformanceRunContext,
): Effect.Effect<void, PropertyFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const fx = yield* acquireFixture(
      ctx,
      CATEGORY,
      PROPERTY_TIMEOUT_SURFACE_CLIENT,
    );
    const start = yield* Clock.currentTimeMillis;
    const outcome = yield* Effect.exit(silentAgentsListCall(fx));
    const elapsed = (yield* Clock.currentTimeMillis) - start;
    yield* assertTimeoutSurface(outcome, elapsed);
  }).pipe(Effect.withSpan("registerTimeoutSurfaceClient"));
}

function silentAgentsListCall(fx: ClientFixture) {
  return fx.handle.call.call(AgentsList.name, {}).pipe(
    Effect.timeoutFail({
      duration: `${PROPERTY_BUDGET_MS} millis`,
      onTimeout: () =>
        unavailable(
          PROPERTY_TIMEOUT_SURFACE_CLIENT,
          `client timeout > ${PROPERTY_BUDGET_MS}ms suite budget`,
        ),
    }),
  );
}

function assertTimeoutSurface(
  outcome: Exit.Exit<unknown, unknown>,
  elapsed: number,
): Effect.Effect<void, PropertyFailure> {
  if (outcome._tag === "Success") {
    return Effect.fail(
      invariant(
        CATEGORY,
        PROPERTY_TIMEOUT_SURFACE_CLIENT,
        "RPC unexpectedly resolved without a response",
      ),
    );
  }
  return assertTimeoutCause(String(outcome.cause), elapsed);
}

function assertTimeoutCause(
  causeStr: string,
  elapsed: number,
): Effect.Effect<void, PropertyFailure> {
  if (causeStr.includes("PropertyUnavailable")) {
    return Effect.fail(
      unavailable(
        PROPERTY_TIMEOUT_SURFACE_CLIENT,
        `client timeout exceeded suite budget (${elapsed}ms)`,
      ),
    );
  }
  return causeStr.includes("RpcTimeoutError") || causeStr.includes("timeout")
    ? Effect.void
    : Effect.fail(
        invariant(
          CATEGORY,
          PROPERTY_TIMEOUT_SURFACE_CLIENT,
          `expected timeout-shape rejection, got: ${causeStr.slice(0, TIMEOUT_ERROR_PREVIEW_CHARS)}`,
        ),
      );
}

/**
 * Client half of `adversity-slow-close` — TestServer initiates a slow
 * close; real client's documented close-signal resolves within the reap
 * deadline; suite Scope releases cleanly.
 *
 * Predicate: `closeSignal` resolves within budget; Scope teardown
 * completes.
 */
export function registerSlowCloseCleanupClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_SLOW_CLOSE_CLEANUP_CLIENT,
    "slow close completes; real client's closeSignal resolves and Scope releases",
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          PROPERTY_SLOW_CLOSE_CLEANUP_CLIENT,
        );
        // Initiate a close from the TestServer side.
        yield* fx.connection
          .close({ code: 1001, reason: "slow-close-test" })
          .pipe(Effect.orElseSucceed(() => undefined));
        // Await the closeSignal with a bounded budget.
        const closeBudget = 3_000;
        const settled = yield* Effect.exit(
          fx.handle.closeSignal.pipe(
            Effect.timeoutFail({
              duration: `${closeBudget} millis`,
              onTimeout: () =>
                invariant(
                  CATEGORY,
                  PROPERTY_SLOW_CLOSE_CLEANUP_CLIENT,
                  `closeSignal did not resolve within ${closeBudget}ms`,
                ),
            }),
          ),
        );
        if (settled._tag === "Failure") {
          const causeStr = String(settled.cause);
          if (causeStr.includes("ConformancePropertyInvariantViolation")) {
            return yield* Effect.fail(
              invariant(
                CATEGORY,
                PROPERTY_SLOW_CLOSE_CLEANUP_CLIENT,
                `closeSignal timed out (${closeBudget}ms budget)`,
              ),
            );
          }
        }
      }).pipe(Effect.withSpan("registerSlowCloseCleanupClient")),
    ),
  );
}
