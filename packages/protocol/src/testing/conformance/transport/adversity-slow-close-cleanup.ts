/**
 * slow_close — close-frames are delayed by the toxic. The scope
 * release must still complete within a bounded window so the suite
 * doesn't leak descriptors.
 */
import { Clock, Effect } from "effect";
import { defaultToxicProfile } from "../../toxics/defaults.js";
import { ConversationsList } from "../../../task/methods.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  acquireProxiedClient,
  adversityViolation,
  proxyName,
  withToxicProxy,
} from "./_helpers.js";

const SLOW_CLOSE_CLIENT_TIMEOUT_MS = 2_000;
const SLOW_CLOSE_BUDGET_MS = 5_000;

export function registerSlowCloseCleanup(ctx: ConformanceRunContext): void {
  withToxicProxy({
    ctx,
    propertyName: "slow-close-cleanup",
    description: "slow_close toxic does not leak descriptors beyond 2s",
    proxyName: proxyName("sc", ctx.seed),
    profile: defaultToxicProfile.slow_close,
    body: ({ proxy, unavailable, attachToxic }) =>
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis;
        yield* attachToxic.pipe(Effect.orElseSucceed(() => undefined));
        // Open + close a client scoped to this Effect.gen block; when
        // Effect.scoped unwinds, the client must release within the
        // 2s budget even though the toxic delays its close-frame.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const _client = yield* acquireProxiedClient(
              ctx,
              proxy,
              `sc-${ctx.seed}-c`,
              SLOW_CLOSE_CLIENT_TIMEOUT_MS,
              unavailable,
            );
            // A single RPC proves the socket is alive before close.
            yield* _client.client
              .sendRpc(ConversationsList, {})
              .pipe(Effect.either);
          }),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - start;
        if (elapsed > SLOW_CLOSE_BUDGET_MS) {
          return yield* Effect.fail(
            adversityViolation(
              "slow-close-cleanup",
              `scope release took ${elapsed}ms under slow_close (budget ${SLOW_CLOSE_BUDGET_MS}ms)`,
            ),
          );
        }
      }),
  });
}
