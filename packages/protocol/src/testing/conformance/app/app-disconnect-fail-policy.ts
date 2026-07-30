/**
 * App-disconnect fail-policy.
 *
 * Contract:
 *   - When an app's WS severs while admission RPCs are in flight, the
 *     server's pending Deferreds fail with a typed close.
 *   - Domain callback services apply fail-CLOSED verdicts:
 *     `before_dispatch` → `decision: "deny"`;
 *     `before_message_delivery` → `block: true`.
 *   - The per-connection appCallback pending map drains; no Deferred leaks past
 *     the connection's Scope.
 *
 * Conformance reach: the fail-closed verdicts are observable through the
 * SENDER's `agent/message/send` / dispatch RPC return — when no app is wired
 * to admit, dispatch proceeds (no admission gate); when an app IS wired
 * and severs mid-flight, dispatch sees the deny verdict.
 *
 * The tasks/* layer creates a task without bootstrapping the
 * manifest-declared conversation map, so this property cannot assemble
 * the dispatch precondition (a non-empty conversation attached to the
 * task) without an app-registration step that is out of scope for the
 * conformance fixture. Property reports `PropertyUnavailable` until a
 * follow-up issue wires the app-topology dispatch precondition. Property
 * ID stays `boundary/app-disconnect-fail-policy`.
 */
import { Effect, type Scope } from "effect";
import { taskRequest } from "#task";
import { makeAgentTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import { registerTestApp, type TestApp } from "../_shared/test-app.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyUnavailable, registerProperty } from "../_shared/registry.js";

const CATEGORY = "boundary";
const PROPERTY = "app-disconnect-fail-policy";
const DEFAULT_TIMEOUT_MS = 3000;

const unavailable = (reason: string): PropertyUnavailable =>
  new PropertyUnavailable({
    category: CATEGORY,
    name: PROPERTY,
    reason,
  });

/**
 * Registers app disconnect fail policy.
 * @param ctx Context for the operation.
 */
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
      // The moderator app is an `AppConnection` (HTTP register + `appKey`
      // Connect); its scope is the surrounding `Effect.scoped`.
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
  return makeAgentTestClient({
    serverUrl: ctx.realServer.wsUrl,
    agentKey: agent.apiKey,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
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
      reason: `${taskRequest.name} does not bootstrap session conversations; needs app-topology dispatch precondition`,
    }),
  );
}
