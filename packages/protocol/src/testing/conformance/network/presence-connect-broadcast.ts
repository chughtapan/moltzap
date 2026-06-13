/**
 * Presence — `agent/network/connect after subscribe` ⇒ subscriber receives
 * `network/presence-changed { online }`.
 */
import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  PRESENCE_CATEGORY,
  acquireClient,
  acquireCloseableClient,
  registerAgent,
  subscribePresence,
  waitForPresenceWithStatus,
} from "./_helpers.js";

export function registerConnectBroadcast(ctx: ConformanceRunContext): void {
  const NAME = "connect-broadcast";
  registerProperty(
    ctx,
    PRESENCE_CATEGORY,
    NAME,
    "agent/network/connect after subscribe ⇒ subscriber receives network/presence-changed { online }",
    Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* acquireClient(ctx, NAME, "p1-sub");
        const a = yield* registerAgent(ctx, NAME, "p1-a");
        yield* subscribePresence(sub.client, a.agentId, NAME);
        yield* acquireCloseableClient(ctx, NAME, a, "p1-a-client");
        yield* waitForPresenceWithStatus(
          sub,
          { agentId: a.agentId, status: "online" },
          NAME,
        );
      }).pipe(Effect.withSpan("registerConnectBroadcast")),
    ),
  );
}
