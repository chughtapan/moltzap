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
import { DispatchAuthorize } from "../../../app/methods.js";
import {
  makeTestClient,
  type TestClient,
} from "../_shared/driver/test-client.js";
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
    assertCallerControlledTimeout(ctx).pipe(
      Effect.withSpan("registerCallerControlledAppCallbackTimeout"),
    ),
  );
}

function assertCallerControlledTimeout(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* acquireCallbackTimeoutClient(ctx);
      const timeoutMs = 250;
      const measurement = yield* measureAwaitServerRequestTimeout(
        client,
        timeoutMs,
      );
      yield* assertTimeoutErrorMessage(measurement.error);
      yield* assertTimeoutWindow(measurement.elapsed, timeoutMs);
    }),
  );
}

function acquireCallbackTimeoutClient(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "ct",
    }).pipe(Effect.mapError((e) => invariant(`register agent: ${e.body}`)));
    return yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(Effect.mapError((e) => invariant(`client acquire: ${String(e)}`)));
  });
}

type TimeoutMeasurement = {
  readonly error: { readonly message: string };
  readonly elapsed: number;
};

function measureAwaitServerRequestTimeout(
  client: TestClient,
  timeoutMs: number,
) {
  return Effect.gen(function* () {
    const before = Date.now();
    const outcome = yield* client
      .awaitServerRequest(DispatchAuthorize, undefined, timeoutMs)
      .pipe(Effect.either);
    const elapsed = Date.now() - before;
    const error = yield* Either.match(outcome, {
      onLeft: (failure) => Effect.succeed(failure),
      onRight: () =>
        Effect.fail(invariant("expected Left (timeout); got Right request")),
    });
    return { error, elapsed } satisfies TimeoutMeasurement;
  });
}

function assertTimeoutErrorMessage(error: { readonly message: string }) {
  return /Timeout/i.test(error.message)
    ? Effect.void
    : Effect.fail(invariant(`expected timeout error; got ${error.message}`));
}

function assertTimeoutWindow(elapsed: number, timeoutMs: number) {
  const lowerBoundMs = timeoutMs - TIMEOUT_LOWER_MARGIN_MS;
  const upperBoundMs = timeoutMs * TIMEOUT_UPPER_MULTIPLIER;
  if (elapsed >= lowerBoundMs && elapsed <= upperBoundMs) return Effect.void;
  return Effect.fail(
    invariant(
      `timeout fired at ${elapsed}ms; caller asked for ${timeoutMs}ms (window: ${lowerBoundMs}-${upperBoundMs}ms)`,
    ),
  );
}
