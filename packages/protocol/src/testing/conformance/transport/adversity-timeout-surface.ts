/**
 * timeout — the toxic black-holes forwarding; the client must surface
 * a typed `RpcTimeoutError` within its own timeout budget (not hang).
 */
import { Clock, Effect, Either } from "effect";
import { defaultToxicProfile } from "../../toxics/defaults.js";
import { ConversationsList } from "@moltzap/protocol/task";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  acquireProxiedClient,
  adversityViolation,
  proxyName,
  withToxicProxy,
} from "./_helpers.js";

const TIMEOUT_SURFACE_PROPERTY = "timeout-surface";
const TIMEOUT_CLIENT_TIMEOUT_MS = 1_500;
const TIMEOUT_EXPECTED_BUDGET_MS = 3_000;

export function registerTimeoutSurface(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: TIMEOUT_SURFACE_PROPERTY,
    description: "timeout toxic surfaces typed RpcTimeoutError within budget",
    proxyName: proxyName("to", ctx.seed),
    profile: defaultToxicProfile.timeout,
    body: ({ proxy, unavailable, attachToxic }) =>
      Effect.gen(function* () {
        // Client timeout must be LESS than the toxic's forwarding
        // timeout so the RPC hits the client-side deadline first.
        // defaultToxicProfile.timeout.timeoutMs = 5000. Set client to
        // 1500ms for a fast, clear timeout surface.
        const proxied = yield* acquireProxiedClient(
          ctx,
          proxy,
          `to-${ctx.seed}-c`,
          TIMEOUT_CLIENT_TIMEOUT_MS,
          unavailable,
        );
        const { outcomeTag, elapsed } = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* attachToxic;
            const start = yield* Clock.currentTimeMillis;
            const outcome = yield* proxied.client
              .sendRpc(ConversationsList, {})
              .pipe(Effect.either);
            const elapsed = (yield* Clock.currentTimeMillis) - start;
            return {
              outcomeTag: Either.match(outcome, {
                onLeft: (error) => error._tag,
                onRight: () => "success",
              }),
              elapsed,
            };
          }),
        );
        if (outcomeTag === "success") {
          return yield* Effect.fail(
            adversityViolation(
              TIMEOUT_SURFACE_PROPERTY,
              "RPC through timeout toxic unexpectedly succeeded",
            ),
          );
        }
        if (outcomeTag !== "TestingRpcTimeoutError") {
          return yield* Effect.fail(
            adversityViolation(
              TIMEOUT_SURFACE_PROPERTY,
              `expected RpcTimeoutError, got ${outcomeTag}`,
            ),
          );
        }
        if (elapsed > TIMEOUT_EXPECTED_BUDGET_MS) {
          return yield* Effect.fail(
            adversityViolation(
              TIMEOUT_SURFACE_PROPERTY,
              `timeout fired at ${elapsed}ms, expected <${TIMEOUT_EXPECTED_BUDGET_MS}ms`,
            ),
          );
        }
      }),
  });
}
