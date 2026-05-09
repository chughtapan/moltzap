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
import { AppsRegister, DispatchAuthorize } from "../../../app/methods.js";
import { TasksCreate } from "../../../task/methods.js";
import { makeTestClient } from "../../test-client.js";
import { registerTestAgent } from "../../agent-registration.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyUnavailable, registerProperty } from "../_shared/registry.js";
import { leftOrNull, sendUntypedRpc } from "../_shared/_helpers.js";

const CATEGORY = "boundary" as const;
const PROPERTY = "app-disconnect-fail-policy";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 32;
const DATE_ID_RADIX = 36;

export function registerAppDisconnectFailPolicy(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "app WS sever ⇒ pending appCallback Deferreds fail-closed; no leaks",
    Effect.scoped(
      Effect.gen(function* () {
        // Step 1: register the app-side agent (will host admission
        // handlers via apps/register).
        const appAgent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "adfp-app",
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyUnavailable({
                category: CATEGORY,
                name: PROPERTY,
                reason: `app agent register: ${e.body}`,
              }),
          ),
        );

        // Step 2: open an app TestClient inside an INNER scope so the
        // property body can sever it without tearing down the outer
        // scope.
        const appScope = yield* Scope.make();
        const appClient = yield* Scope.extend(
          makeTestClient({
            serverUrl: ctx.realServer.wsUrl,
            agentKey: appAgent.apiKey,
            agentId: appAgent.agentId,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            captureCapacity: DEFAULT_CAPTURE_CAPACITY,
          }),
          appScope,
        ).pipe(
          Effect.mapError(
            (e) =>
              new PropertyUnavailable({
                category: CATEGORY,
                name: PROPERTY,
                reason: `app client acquire: ${String(e)}`,
              }),
          ),
        );

        // Step 3: register a manifest. apps/register is owner-agnostic
        // (see apps.handlers.ts:25-41) — succeeds even when the agent's
        // owner_user_id is null.
        const appId = `adfp-${Date.now().toString(DATE_ID_RADIX)}`;
        const registerOutcome = yield* sendUntypedRpc(appClient, AppsRegister, {
          manifest: {
            appId,
            name: `Disconnect-fail app ${appId}`,
            conversations: [
              { key: "main", name: "Main", participantFilter: "all" },
            ],
            hooks: {
              dispatch_authorize: { timeout_ms: 5000 },
            },
          },
        }).pipe(Effect.either);
        const registerFailure = leftOrNull(registerOutcome);
        if (registerFailure !== null) {
          yield* Scope.close(appScope, Exit.void);
          return yield* Effect.fail(
            new PropertyUnavailable({
              category: CATEGORY,
              name: PROPERTY,
              reason: `apps/register failed: ${registerFailure._tag}`,
            }),
          );
        }

        // Step 4: register an admission handler that NEVER replies, so
        // the server-side Deferred is parked. The sever in step 6 is the
        // event the property exercises. Single `handleServerRpc`
        // registration covers the property — only `dispatch/authorize`
        // is left in the task-callback group.
        yield* appClient.handleServerRpc(DispatchAuthorize, () => Effect.never);

        // Step 5: register a sender agent and attempt to create an app
        // session that this agent initiates. apps/create requires the
        // initiator's owner_user_id to be non-null (app-host.ts:629);
        // the default conformance fixture sets it to null. When the
        // prerequisite is absent, report unavailable — B.9 exercises the
        // full path with DB-level owner_user_id seeding.
        const sender = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "adfp-sender",
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyUnavailable({
                category: CATEGORY,
                name: PROPERTY,
                reason: `sender register: ${e.body}`,
              }),
          ),
        );
        const senderClient = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: sender.apiKey,
          agentId: sender.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: DEFAULT_CAPTURE_CAPACITY,
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyUnavailable({
                category: CATEGORY,
                name: PROPERTY,
                reason: `sender client acquire: ${String(e)}`,
              }),
          ),
        );
        // Phase 7 cutover removed `apps/create`'s session machinery. The
        // tasks/* layer creates a task without bootstrapping the
        // manifest-declared conversation map, so this property cannot
        // assemble the dispatch precondition (a non-empty conversation
        // attached to the task) without a TM-registration step that is
        // out of scope for the conformance fixture. Tombstone to Phase 9
        // (#318) where the TM topology owns the dispatch precondition.
        // The `senderClient` is constructed above only to surface a
        // `PropertyUnavailable` reason that names the missing
        // dependency; the suspect-the-leak dispatch round-trip is
        // unreachable.
        void senderClient;
        yield* Scope.close(appScope, Exit.void);
        return yield* Effect.fail(
          new PropertyUnavailable({
            category: CATEGORY,
            name: PROPERTY,
            reason: `${TasksCreate.name} does not bootstrap session conversations; covered in Phase 9 with TM topology (#318)`,
          }),
        );
      }),
    ),
  );
}
