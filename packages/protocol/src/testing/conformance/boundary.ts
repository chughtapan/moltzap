/**
 * Boundary — server-side safety surfaces that no single RPC exercises.
 * Historical grouping note: spec #181 §5 calls this "Tier E". Code uses
 * semantic names only.
 *
 * The app-callback-RPC fail-on-app-disconnect invariant — replacing the deleted
 * `webhook-graceful-shutdown` probe under B.1's awaitable RPC transport
 * — is registered as `app-disconnect-fail-policy` below.
 */
import * as fc from "fast-check";
import { Data, Duration, Effect, Either, Exit, Scope } from "effect";
import { allRpcMethods, arbitraryCallFor } from "../arbitraries/rpc.js";
import { makeTestClient } from "../test-client.js";
import { registerTestAgent } from "../agent-registration.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  PropertyDeferred,
  PropertyInvariantViolation,
  PropertyUnavailable,
  registerProperty,
} from "./registry.js";
import { leftOrNull, sendUntypedRpc } from "./_helpers.js";

import { AgentsList } from "../../schema/methods/auth.js";
import {
  AppsAuthorizeDispatch,
  AppsCreate,
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsRegister,
} from "../../schema/methods/apps.js";
import { conversationId, messageId } from "../../schema/primitives.js";

/**
 * Tagged sentinel for "the dispatch RPC did not reply within the
 * property's bound." Distinct from any wire-level RpcResponseError so
 * the property body's Right/Left discrimination cannot mistake a typed
 * fail-closed verdict for a hang.
 */
class DispatchHungError extends Data.TaggedError(
  "ConformanceDispatchHungError",
)<{ readonly elapsedMs: number }> {}

const CATEGORY = "boundary" as const;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 32;
const SCHEMA_EXHAUSTIVE_FUZZ_PROPERTY = "schema-exhaustive-fuzz";
const APP_DISCONNECT_FAIL_POLICY_PROPERTY = "app-disconnect-fail-policy";
const FUZZ_CAPTURE_CAPACITY_PER_METHOD = 4;
const DATE_ID_RADIX = 36;

/**
 * Schema-exhaustive fuzz — for every `RpcMethodName`, draws arbitrary
 * valid params, sends through a real TestClient, and asserts the server
 * survives. Reuses a single TestClient across the whole iteration so
 * the suite doesn't open 40+ sockets in serial; each method runs behind
 * the same post-call liveness probe.
 *
 * Iterates every `RpcMethodName`. Failure on any single method halts
 * the property with a `PropertyInvariantViolation` naming the offender,
 * so artifacts are actionable.
 */
export function registerSchemaExhaustiveFuzz(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    SCHEMA_EXHAUSTIVE_FUZZ_PROPERTY,
    "every RpcMethodName drawn → server survives & stays responsive",
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "fuzz",
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: SCHEMA_EXHAUSTIVE_FUZZ_PROPERTY,
                reason: `register agent: ${e.body}`,
              }),
          ),
        );
        const client = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: agent.apiKey,
          agentId: agent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity:
            allRpcMethods.length * FUZZ_CAPTURE_CAPACITY_PER_METHOD,
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: SCHEMA_EXHAUSTIVE_FUZZ_PROPERTY,
                reason: `client acquire: ${String(e)}`,
              }),
          ),
        );
        const samplesPerMethod = ctx.opts.numRuns ?? 1;
        for (const method of allRpcMethods) {
          const callArb = arbitraryCallFor(method);
          const samples = fc.sample(callArb, {
            numRuns: samplesPerMethod,
            seed: ctx.seed,
          });
          if (samples.length === 0) {
            return yield* Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: SCHEMA_EXHAUSTIVE_FUZZ_PROPERTY,
                reason: `failed to sample call for ${method}`,
              }),
            );
          }
          for (const sampled of samples) {
            yield* client
              .sendRpc(sampled.definition, sampled.params)
              .pipe(Effect.either);
            // Post-fuzz liveness: a follow-up RPC must return a typed
            // response. Accepting any `Left` would let a timeout or
            // transport-close slip through as "server alive" — which is
            // exactly what the property must reject. Require the post
            // call to SUCCEED; timeouts are failures here.
            const post = yield* client
              .sendRpc(AgentsList, {})
              .pipe(Effect.either);
            const postFailure = leftOrNull(post);
            if (postFailure !== null) {
              return yield* Effect.fail(
                new PropertyInvariantViolation({
                  category: CATEGORY,
                  name: SCHEMA_EXHAUSTIVE_FUZZ_PROPERTY,
                  reason: `server became unresponsive after ${method} (post-call ${postFailure._tag})`,
                }),
              );
            }
          }
        }
      }),
    ),
  );
}

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
 * Wiring an app over WS requires `apps/create` (server-internal: agent
 * owner_user_id must be set, see `app-host.ts:629`). The conformance
 * suite registers agents via the public `/api/v1/auth/register` endpoint,
 * which sets owner_user_id to `config.devModeUserId ?? null`; the
 * default `startCoreTestServer` does not bind a `devModeUserId`. When
 * the prerequisite is absent, this property reports
 * `PropertyUnavailable` with the precise reason — the assertions
 * themselves are exercised at the integration tier (B.9 / sub-issue
 * #318) where DB access fills the gap.
 *
 * This shape mirrors `adversity.registerLatencyResilience` /
 * `adversity.registerSlicerFraming`, which report `PropertyUnavailable`
 * when Toxiproxy is not provisioned. The conformance contract (the
 * architect plan §8.3 acceptance) is encoded by the registered property;
 * runnability is gated on the consumer's fixture capabilities.
 */
export function registerAppDisconnectFailPolicy(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    APP_DISCONNECT_FAIL_POLICY_PROPERTY,
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
                name: APP_DISCONNECT_FAIL_POLICY_PROPERTY,
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
                name: APP_DISCONNECT_FAIL_POLICY_PROPERTY,
                reason: `app client acquire: ${String(e)}`,
              }),
          ),
        );

        // Step 3: register a manifest. apps/register is owner-agnostic
        // (see apps.handlers.ts:25-41) — succeeds even when the agent's
        // owner_user_id is null.
        const appId = `adfp-${Date.now().toString(DATE_ID_RADIX)}`;
        // `apps/register` is server-handled but absent from the typed
        // `rpcMethods` registry today (see `rpc-registry.ts:60-118`);
        // app-sdk and `34-rpc-additions.integration.test.ts:48` use the
        // same untyped-cast path. Adding it to the registry is an
        // accretive change outside this sub-issue's scope.
        const registerOutcome = yield* sendUntypedRpc(
          appClient,
          AppsRegister.name,
          {
            manifest: {
              appId,
              name: `Disconnect-fail app ${appId}`,
              permissions: { required: [], optional: [] },
              conversations: [
                { key: "main", name: "Main", participantFilter: "all" },
              ],
              hooks: {
                before_dispatch: { timeout_ms: 5000 },
                before_message_delivery: { timeout_ms: 5000 },
              },
            },
          },
        ).pipe(Effect.either);
        const registerFailure = leftOrNull(registerOutcome);
        if (registerFailure !== null) {
          yield* Scope.close(appScope, Exit.void);
          return yield* Effect.fail(
            new PropertyUnavailable({
              category: CATEGORY,
              name: APP_DISCONNECT_FAIL_POLICY_PROPERTY,
              reason: `apps/register failed: ${registerFailure._tag}`,
            }),
          );
        }

        // Step 4: register an admission handler that NEVER replies, so
        // the server-side Deferred is parked. The sever in step 6 is the
        // event the property exercises.
        yield* appClient.handleServerRpc(
          AppsOnBeforeDispatch,
          () => Effect.never,
        );
        yield* appClient.handleServerRpc(
          AppsOnBeforeMessageDelivery,
          () => Effect.never,
        );

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
                name: APP_DISCONNECT_FAIL_POLICY_PROPERTY,
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
                name: APP_DISCONNECT_FAIL_POLICY_PROPERTY,
                reason: `sender client acquire: ${String(e)}`,
              }),
          ),
        );
        const sessionOutcome = yield* senderClient
          .sendRpc(AppsCreate, { appId, invitedAgentIds: [] })
          .pipe(Effect.either);
        const sessionResult = yield* Either.match(sessionOutcome, {
          onLeft: (error) =>
            Scope.close(appScope, Exit.void).pipe(
              Effect.zipRight(
                Effect.fail(
                  new PropertyUnavailable({
                    category: CATEGORY,
                    name: APP_DISCONNECT_FAIL_POLICY_PROPERTY,
                    reason: `apps/create failed (likely owner_user_id null on sender; B.9 covers via DB seeding): ${error._tag}`,
                  }),
                ),
              ),
            ),
          onRight: (success) => Effect.succeed(success),
        });

        // Step 6: sever the app's WS. Closing the inner scope closes the
        // socket; the server's connection-scope finalizer runs through
        // sendRpcToClient's Deferred-cleanup path (issue #310).
        yield* Scope.close(appScope, Exit.void);

        // Step 7: trigger an admission round-trip on the sender side
        // through the session's main conversation. Codex review (#327,
        // finding 2): a fixed zero-UUID conversation short-circuits
        // grant in `AppHost.runBeforeDispatch`, so the property would
        // pass even if fail-closed-on-disconnect was broken; route
        // through the session's actual conversation so AppHost reaches
        // the (now severed) admission path.
        // `apps/create` result: `{ session: { conversations: { [key]: convId } } }`
        // — a Record map, not an array. Pull the first id deterministically.
        const session = sessionResult.session;
        const sessionConvId = Object.values(session.conversations)[0];
        if (typeof sessionConvId !== "string" || sessionConvId.length === 0) {
          return yield* Effect.fail(
            new PropertyDeferred({
              category: CATEGORY,
              name: APP_DISCONNECT_FAIL_POLICY_PROPERTY,
              followUp:
                "apps/create response did not surface a session conversation id; B.9 (#318) covers via DB-seeded fixture",
            }),
          );
        }
        // Codex review (#327, finding 3): use timeoutFail with a tagged
        // sentinel. Effect.timeout returns Option, and either-wrapping
        // surfaces the fiber's TimeoutException, so the previous shape
        // could not distinguish "client RPC timeout" (typed fail-closed)
        // from "wall-clock hang" (Deferred leak). The sentinel error
        // class makes the leak observable in the Left branch.
        const dispatchStarted = Date.now();
        const dispatchOutcome = yield* senderClient
          .sendRpc(AppsAuthorizeDispatch, {
            conversationId: conversationId(sessionConvId),
            messageId: messageId("00000000-0000-0000-0000-000000000001"),
            senderAgentId: sender.agentId,
          })
          .pipe(
            Effect.timeoutFail({
              duration: Duration.millis(DEFAULT_TIMEOUT_MS),
              onTimeout: () =>
                new DispatchHungError({
                  elapsedMs: Date.now() - dispatchStarted,
                }),
            }),
            Effect.either,
          );
        const dispatchHung = Either.match(dispatchOutcome, {
          onLeft: (error) =>
            error instanceof DispatchHungError ? error : null,
          onRight: () => null,
        });
        if (dispatchHung !== null) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: APP_DISCONNECT_FAIL_POLICY_PROPERTY,
              reason: `dispatch hung ${dispatchHung.elapsedMs}ms after app sever — Deferred leak suspected`,
            }),
          );
        }
      }),
    ),
  );
}
