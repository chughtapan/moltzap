/**
 * reset_peer — mid-flight the toxic forcibly resets the connection.
 * Sender RPCs surface a typed `TransportClosedError`, never hang, and never
 * crash. Full store-and-replay is a consumer-side concern driven by each real
 * lifecycle client; the protocol-level guarantee is that the agent client
 * surfaces the transport failure as a typed outcome.
 */
import { Clock, Effect, Either } from "effect";
import { defaultToxicProfile } from "../../toxics/defaults.js";
import { TransportClosedError } from "../_shared/errors.js";
import type { AgentTestClient } from "../_shared/driver/test-client.js";
import { TaskList } from "#task";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyUnavailable } from "../_shared/registry.js";
import {
  acquireProxiedClient,
  ADVERSITY_CATEGORY,
  proxyName,
  type ToxicBodyParams,
  withToxicProxy,
} from "./_helpers.js";

const RESET_CLIENT_TIMEOUT_MS = 4_000;
const RESET_POLL_ATTEMPTS = 10;
const RESET_CLOSE_BUDGET_MS = 3_500;

export function registerResetPeerRecovery(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "reset-peer-recovery",
    description: "reset_peer surfaces TransportClosedError without hanging",
    proxyName: proxyName("rst", ctx.seed),
    profile: defaultToxicProfile.reset_peer,
    body: (params) =>
      runResetPeerRecovery(ctx, params).pipe(
        Effect.withSpan("registerResetPeerRecovery"),
      ),
  });
}

function runResetPeerRecovery(
  ctx: ConformanceRunContext,
  params: ToxicBodyParams,
) {
  return Effect.gen(function* () {
    const sender = yield* acquireProxiedClient({
      ctx,
      proxy: params.proxy,
      name: `rst-${ctx.seed}-s`,
      defaultTimeoutMs: RESET_CLIENT_TIMEOUT_MS,
      unavailable: params.unavailable,
    });
    const observed = yield* observeResetClose(
      sender.client,
      params.attachToxic,
    );
    if (!observed) {
      return yield* Effect.fail(resetUnavailable());
    }
  });
}

function observeResetClose(
  client: AgentTestClient,
  attachToxic: ToxicBodyParams["attachToxic"],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* attachToxic;
      const start = yield* Clock.currentTimeMillis;
      for (let i = 0; i < RESET_POLL_ATTEMPTS; i++) {
        if (yield* rpcClosedByTransport(client)) return true;
        yield* Effect.sleep("300 millis");
        if (yield* resetBudgetExceeded(start)) return false;
      }
      return false;
    }),
  );
}

function rpcClosedByTransport(client: AgentTestClient) {
  return Effect.gen(function* () {
    const outcome = yield* client.sendRpc(TaskList, {}).pipe(Effect.either);
    return Either.match(outcome, {
      onLeft: (error) => error instanceof TransportClosedError,
      onRight: () => false,
    });
  });
}

function resetBudgetExceeded(start: number) {
  return Effect.gen(function* () {
    const elapsed = (yield* Clock.currentTimeMillis) - start;
    return elapsed > RESET_CLOSE_BUDGET_MS;
  });
}

function resetUnavailable(): PropertyUnavailable {
  return new PropertyUnavailable({
    category: ADVERSITY_CATEGORY,
    name: "reset-peer-recovery",
    reason: "reset_peer toxic did not close within 3.5s budget",
  });
}
