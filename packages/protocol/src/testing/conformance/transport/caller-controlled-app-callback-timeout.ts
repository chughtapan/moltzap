/**
 * Caller-controlled appCallback timeout — `awaitServerRequest(method, undef,
 * timeoutMs)` returns a timeout error when no appCallback request arrives in the
 * window. Architect plan §3.4: timeout policy lives in the caller
 * (`Effect.timeout(manifestHookTimeout)` at the AppHost call site), NOT
 * in the schema. This property anchors the caller-side behaviour the
 * AppHost relies on.
 *
 * Pure-TestClient property — fast, deterministic, no real-server hook
 * machinery required. Asserts the timeout is OBSERVABLE (a typed Error)
 * and FIRES IN THE WINDOW the caller passed (within 2x to absorb CI
 * scheduling noise).
 */
import { Effect, Either } from "effect";
import { DispatchAuthorize } from "@moltzap/protocol/app";
import { makeTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";

const CATEGORY = "rpc-semantics" as const;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;
const PROPERTY = "caller-controlled-app-callback-timeout";
const TIMEOUT_LOWER_MARGIN_MS = 20;
const TIMEOUT_UPPER_MULTIPLIER = 4;

const invariant = (reason: string): PropertyInvariantViolation =>
  new PropertyInvariantViolation({
    category: CATEGORY,
    name: PROPERTY,
    reason,
  });

export function registerCallerControlledAppCallbackTimeout(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "awaitServerRequest(_, _, timeoutMs) fires within the caller's window",
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "ct",
        }).pipe(Effect.mapError((e) => invariant(`register agent: ${e.body}`)));
        const client = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: agent.apiKey,
          agentId: agent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: DEFAULT_CAPTURE_CAPACITY,
        }).pipe(
          Effect.mapError((e) => invariant(`client acquire: ${String(e)}`)),
        );
        // 250ms (rather than the architect plan's example 100ms) hardens
        // against CI scheduler tails; loaded shared runners can absorb
        // 200–500ms on a 100ms timer, while a 250ms timer with the same
        // 4× upper bound stays well clear of the flake band.
        const timeoutMs = 250;
        const lowerBoundMs = timeoutMs - TIMEOUT_LOWER_MARGIN_MS;
        const upperBoundMs = timeoutMs * TIMEOUT_UPPER_MULTIPLIER;
        const before = Date.now();
        const outcome = yield* client
          .awaitServerRequest(DispatchAuthorize, undefined, timeoutMs)
          .pipe(Effect.either);
        const elapsed = Date.now() - before;
        const timeoutError = yield* Either.match(outcome, {
          onLeft: (error) => Effect.succeed(error),
          onRight: () =>
            Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: PROPERTY,
                reason: `expected Left (timeout); got Right (appCallback request fired)`,
              }),
            ),
        });
        if (!/Timeout/i.test(timeoutError.message)) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: PROPERTY,
              reason: `expected timeout error; got ${timeoutError.message}`,
            }),
          );
        }
        // Window is the caller's. Floor rejects "timed out before the
        // caller's deadline" — would mean a schema-level cap is shadowing
        // the manifest timeout. Ceiling rejects "still timing out long
        // after the caller's deadline" — would mean the manifest timeout
        // does not actually drive the firing.
        if (elapsed < lowerBoundMs || elapsed > upperBoundMs) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: PROPERTY,
              reason: `timeout fired at ${elapsed}ms; caller asked for ${timeoutMs}ms (window: ${lowerBoundMs}–${upperBoundMs}ms)`,
            }),
          );
        }
      }).pipe(Effect.withSpan("registerCallerControlledAppCallbackTimeout")),
    ),
  );
}
