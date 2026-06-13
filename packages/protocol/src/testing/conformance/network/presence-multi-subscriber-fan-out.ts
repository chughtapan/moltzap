/**
 * Multi-subscriber fan-out — `agent/network/connect` with N subscribers ⇒
 * exactly N `network/presence-changed { online }` events (one per subscriber).
 */
import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  PRESENCE_CATEGORY,
  acquireClient,
  acquireCloseableClient,
  countPresenceChangedFor,
  presenceViolation,
  registerAgent,
  subscribePresence,
  waitForPresenceWithStatus,
} from "./_helpers.js";

export function registerMultiSubscriberFanOut(
  ctx: ConformanceRunContext,
): void {
  const NAME = "multi-subscriber-fan-out";
  registerProperty(
    ctx,
    PRESENCE_CATEGORY,
    NAME,
    "agent/network/connect with N subscribers ⇒ exactly N network/presence-changed { online } events (one per subscriber)",
    Effect.scoped(
      Effect.gen(function* () {
        const s1 = yield* acquireClient(ctx, NAME, "p5-s1");
        const s2 = yield* acquireClient(ctx, NAME, "p5-s2");
        const a = yield* registerAgent(ctx, NAME, "p5-a");
        yield* subscribePresence(s1.client, a.agentId, NAME);
        yield* subscribePresence(s2.client, a.agentId, NAME);
        yield* acquireCloseableClient(ctx, NAME, a, "p5-a-client");

        yield* waitForPresenceWithStatus(
          s1,
          { agentId: a.agentId, status: "online" },
          NAME,
        );
        yield* waitForPresenceWithStatus(
          s2,
          { agentId: a.agentId, status: "online" },
          NAME,
        );

        const c1 = yield* countPresenceChangedFor(s1, a.agentId);
        const c2 = yield* countPresenceChangedFor(s2, a.agentId);
        if (c1 !== 1 || c2 !== 1) {
          return yield* Effect.fail(
            presenceViolation(
              NAME,
              `expected exactly 1 event per subscriber, observed s1=${c1} s2=${c2}`,
            ),
          );
        }
      }).pipe(Effect.withSpan("registerMultiSubscriberFanOut")),
    ),
  );
}
