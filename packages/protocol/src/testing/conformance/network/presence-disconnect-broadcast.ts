/**
 * Presence — `ws-close after network/connect` ⇒ subscriber receives
 * `presence/changed { offline }` strictly after `{ online }`.
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

export function registerDisconnectBroadcast(ctx: ConformanceRunContext): void {
  const NAME = "disconnect-broadcast";
  registerProperty(
    ctx,
    PRESENCE_CATEGORY,
    NAME,
    "ws-close after network/connect ⇒ subscriber receives presence/changed { offline } strictly after { online }",
    Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* acquireClient(ctx, NAME, "p2-sub");
        const a = yield* registerAgent(ctx, NAME, "p2-a");
        yield* subscribePresence(sub.client, a.agentId, NAME);
        const aClient = yield* acquireCloseableClient(
          ctx,
          NAME,
          a,
          "p2-a-client",
        );
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );
        yield* aClient.close;
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "offline" },
          NAME,
        );
      }).pipe(Effect.withSpan("registerDisconnectBroadcast")),
    ),
  );
}
