/**
 * App-disconnect fail-policy — replacement for the deleted webhook
 * graceful-shutdown probe (architect plan §8.3).
 *
 * Architect contract:
 *   - When an app's WS severs while admission RPCs are in flight, the
 *     server's pending Deferreds fail with a typed close.
 *   - AppHost applies fail-CLOSED verdicts: `before_dispatch` →
 *     `decision: "deny"`; `before_message_delivery` → `block: true`.
 *   - The per-connection appCallback pending map drains; no Deferred leaks past
 *     the connection's Scope.
 *
 * Conformance reach: the fail-closed verdicts are observable through the
 * SENDER's `messages/send` / dispatch RPC return — when no app is wired
 * to admit, dispatch proceeds (no admission gate); when an app IS wired
 * and severs mid-flight, dispatch sees the deny verdict.
 *
 * Phase 7 cutover removed `apps/createSession`'s session machinery. The
 * tasks/* layer creates a task without bootstrapping the
 * manifest-declared conversation map, so this property cannot
 * assemble the dispatch precondition (a non-empty conversation
 * attached to the task) without a TM-registration step that is
 * out of scope for the conformance fixture. Property reports
 * `PropertyUnavailable` until a follow-up issue wires the TM-topology
 * dispatch precondition. Property ID stays
 * `boundary/app-disconnect-fail-policy` to preserve the conformance
 * baseline (architect §7).
 */
import { Effect, type Scope } from "effect";
import { TaskRequest } from "../../../task/methods.js";
import { makeTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import { registerTestApp, type TestApp } from "../_shared/test-app.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyUnavailable, registerProperty } from "../_shared/registry.js";

const CATEGORY = "boundary" as const;
const PROPERTY = "app-disconnect-fail-policy";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 32;

const unavailable = (reason: string): PropertyUnavailable =>
  new PropertyUnavailable({
    category: CATEGORY,
    name: PROPERTY,
    reason,
  });

export function registerAppDisconnectFailPolicy(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "app WS sever ⇒ pending appCallback Deferreds fail-closed; no leaks",
    runAppDisconnectFailPolicy(ctx).pipe(
      Effect.withSpan("registerAppDisconnectFailPolicy"),
    ),
  );
}

function runAppDisconnectFailPolicy(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      // D #705 CP9 — the moderator app is an `AppConnection` (HTTP register
      // + `appKey` Connect); its scope is the surrounding `Effect.scoped`.
      const app = yield* registerDisconnectFailApp(ctx);
      yield* app.dispatchAuthorize.silence;
      yield* acquireSenderClient(ctx);
      return yield* missingTopologyUnavailable();
    }),
  );
}

function registerAgent(
  ctx: ConformanceRunContext,
  name: string,
  label: string,
) {
  return registerTestAgent({
    baseUrl: ctx.realServer.baseUrl,
    name,
  }).pipe(Effect.mapError((e) => unavailable(`${label} register: ${e.body}`)));
}

function makeAgentClient(ctx: ConformanceRunContext, agent: TestAgent) {
  return makeTestClient({
    serverUrl: ctx.realServer.wsUrl,
    agentKey: agent.apiKey,
    agentId: agent.agentId,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    captureCapacity: DEFAULT_CAPTURE_CAPACITY,
  });
}

function acquireClient(
  ctx: ConformanceRunContext,
  agent: TestAgent,
  label: string,
) {
  return makeAgentClient(ctx, agent).pipe(
    Effect.mapError((e) => unavailable(`${label} acquire: ${String(e)}`)),
  );
}

function registerDisconnectFailApp(
  ctx: ConformanceRunContext,
): Effect.Effect<TestApp, PropertyUnavailable, Scope.Scope> {
  const appId = crypto.randomUUID();
  return registerTestApp({
    baseUrl: ctx.realServer.baseUrl,
    wsUrl: ctx.realServer.wsUrl,
    appId,
    name: `Disconnect-fail app ${appId}`,
    dispatchAuthorizeTimeoutMs: 5_000,
  }).pipe(Effect.mapError((e) => unavailable(e._tag)));
}

function acquireSenderClient(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const sender = yield* registerAgent(ctx, "adfp-sender", "sender");
    yield* acquireClient(ctx, sender, "sender client");
  });
}

function missingTopologyUnavailable() {
  return Effect.fail(
    new PropertyUnavailable({
      category: CATEGORY,
      name: PROPERTY,
      reason: `${TaskRequest.name} does not bootstrap session conversations; covered in Phase 9 with TM topology (#318)`,
    }),
  );
}
