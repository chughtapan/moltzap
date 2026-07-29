/**
 * Timeout — the toxic black-holes forwarding; the client must surface
 * a typed `RpcTimeoutError` within its own timeout budget (not hang).
 */
import { Clock, Effect, Either } from "effect";
import { defaultToxicProfile } from "../../toxics/defaults.js";
import { RpcTimeoutError } from "../_shared/errors.js";
import type { AgentTestClient } from "../_shared/driver/test-client.js";
import { taskList } from "#task";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  acquireProxiedClient,
  adversityViolation,
  proxyName,
  type ToxicBodyParams,
  withToxicProxy,
} from "./_helpers.js";

const TIMEOUT_SURFACE_PROPERTY = "timeout-surface";
const TIMEOUT_CLIENT_TIMEOUT_MS = 1_500;
const TIMEOUT_EXPECTED_BUDGET_MS = 3_000;

/**
 * Registers timeout surface.
 * @param ctx Context for the operation.
 */
export function registerTimeoutSurface(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: TIMEOUT_SURFACE_PROPERTY,
    description: "timeout toxic surfaces typed RpcTimeoutError within budget",
    proxyName: proxyName("to", ctx.seed),
    profile: defaultToxicProfile.timeout,
    body: (params) =>
      runTimeoutSurface(ctx, params).pipe(
        Effect.withSpan("registerTimeoutSurface"),
      ),
  });
}

function runTimeoutSurface(
  ctx: ConformanceRunContext,
  params: ToxicBodyParams,
) {
  return Effect.gen(function* () {
    const proxied = yield* acquireProxiedClient({
      ctx,
      proxy: params.proxy,
      name: `to-${ctx.seed}-c`,
      defaultTimeoutMs: TIMEOUT_CLIENT_TIMEOUT_MS,
      unavailable: params.unavailable,
    });
    const result = yield* measureTimeoutOutcome(
      proxied.client,
      params.attachToxic,
    );
    yield* assertTimeoutError(result.error);
    yield* assertTimeoutBudget(result.elapsed);
  });
}

interface TimeoutResult {
  readonly error: unknown | null;
  readonly elapsed: number;
}

function measureTimeoutOutcome(
  client: AgentTestClient,
  attachToxic: ToxicBodyParams["attachToxic"],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* attachToxic;
      const start = yield* Clock.currentTimeMillis;
      const outcome = yield* client.sendRpc(taskList, {}).pipe(Effect.either);
      const elapsed = (yield* Clock.currentTimeMillis) - start;
      const error = Either.match(outcome, {
        onLeft: (failure) => failure,
        onRight: () => null,
      });
      return { error, elapsed } satisfies TimeoutResult;
    }),
  );
}

function assertTimeoutError(error: unknown | null) {
  if (error === null) {
    return Effect.fail(
      adversityViolation(
        TIMEOUT_SURFACE_PROPERTY,
        "RPC through timeout toxic unexpectedly succeeded",
      ),
    );
  }
  return error instanceof RpcTimeoutError
    ? Effect.void
    : Effect.fail(
        adversityViolation(
          TIMEOUT_SURFACE_PROPERTY,
          `expected RpcTimeoutError, got ${String(error)}`,
        ),
      );
}

function assertTimeoutBudget(elapsed: number) {
  return elapsed <= TIMEOUT_EXPECTED_BUDGET_MS
    ? Effect.void
    : Effect.fail(
        adversityViolation(
          TIMEOUT_SURFACE_PROPERTY,
          `timeout fired at ${elapsed}ms, expected <${TIMEOUT_EXPECTED_BUDGET_MS}ms`,
        ),
      );
}
