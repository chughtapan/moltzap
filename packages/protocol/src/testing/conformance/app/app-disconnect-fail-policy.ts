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
import { Effect, Exit, Scope } from "effect";
import { TasksCreate } from "../../../task/methods.js";
import {
  makeTestClient,
  type TestClient,
} from "../_shared/driver/test-client.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import {
  makeTestAppManifest,
  registerTestApp,
  type TestApp,
} from "../_shared/test-app.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyUnavailable, registerProperty } from "../_shared/registry.js";

const CATEGORY = "boundary" as const;
const PROPERTY = "app-disconnect-fail-policy";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 32;
const DATE_ID_RADIX = 36;

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

type AppClientSession = {
  readonly scope: Scope.CloseableScope;
  readonly client: TestClient;
};

function runAppDisconnectFailPolicy(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const appSession = yield* acquireAppClientSession(ctx);
      const app = yield* registerDisconnectFailApp(appSession).pipe(
        Effect.catchAll((e) =>
          closeAppSession(appSession).pipe(Effect.zipRight(Effect.fail(e))),
        ),
      );
      yield* app.dispatchAuthorize.silence;
      yield* acquireSenderClient(ctx);
      yield* closeAppSession(appSession);
      return yield* missingTopologyUnavailable();
    }),
  );
}

function acquireAppClientSession(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const appAgent = yield* registerAgent(ctx, "adfp-app", "app agent");
    const scope = yield* Scope.make();
    const client = yield* acquireScopedClient(
      ctx,
      appAgent,
      "app client",
      scope,
    );
    return { scope, client } satisfies AppClientSession;
  });
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

function acquireScopedClient(
  ctx: ConformanceRunContext,
  agent: TestAgent,
  label: string,
  scope: Scope.CloseableScope,
) {
  return Scope.extend(makeAgentClient(ctx, agent), scope).pipe(
    Effect.mapError((e) => unavailable(`${label} acquire: ${String(e)}`)),
    Effect.tapError(() => Scope.close(scope, Exit.void)),
  );
}

function registerDisconnectFailApp(
  session: AppClientSession,
): Effect.Effect<TestApp, PropertyUnavailable> {
  const appId = `adfp-${Date.now().toString(DATE_ID_RADIX)}`;
  return registerTestApp({
    client: session.client,
    manifest: makeTestAppManifest({
      appId,
      name: `Disconnect-fail app ${appId}`,
      dispatchAuthorizeTimeoutMs: 5_000,
    }),
  }).pipe(Effect.mapError((e) => unavailable(e.message)));
}

function acquireSenderClient(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const sender = yield* registerAgent(ctx, "adfp-sender", "sender");
    yield* acquireClient(ctx, sender, "sender client");
  });
}

function closeAppSession(session: AppClientSession) {
  return Scope.close(session.scope, Exit.void);
}

function missingTopologyUnavailable() {
  return Effect.fail(
    new PropertyUnavailable({
      category: CATEGORY,
      name: PROPERTY,
      reason: `${TasksCreate.name} does not bootstrap session conversations; covered in Phase 9 with TM topology (#318)`,
    }),
  );
}
