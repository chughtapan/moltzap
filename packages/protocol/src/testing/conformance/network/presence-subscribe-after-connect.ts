/**
 * Subscribing AFTER an agent connects ⇒ snapshot reflects status: online.
 */
import { Effect } from "effect";
import { AgentPresenceSubscribe } from "../../../network/presence.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  PRESENCE_CATEGORY,
  acquireClient,
  acquireCloseableClient,
  presenceViolation,
  registerAgent,
  type PresenceChangedPayload,
} from "./_helpers.js";

export function registerSubscribeAfterConnect(
  ctx: ConformanceRunContext,
): void {
  const NAME = "subscribe-after-connect";
  registerProperty(
    ctx,
    PRESENCE_CATEGORY,
    NAME,
    "subscribing AFTER an agent connects ⇒ snapshot reflects status: online",
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* registerAgent(ctx, NAME, "p6-a");
        yield* acquireCloseableClient(ctx, NAME, a, "p6-a-client");

        const sub = yield* acquireClient(ctx, NAME, "p6-sub");
        const result = yield* sub.client
          .sendRpc(AgentPresenceSubscribe, { agentIds: [a.agentId] })
          .pipe(
            Effect.mapError((e) =>
              presenceViolation(
                NAME,
                `presence/subscribe failed: ${String(e)}`,
              ),
            ),
          );
        const statuses = (
          result as {
            statuses: ReadonlyArray<PresenceChangedPayload>;
          }
        ).statuses;
        if (statuses.length !== 1) {
          return yield* Effect.fail(
            presenceViolation(
              NAME,
              `expected 1 status entry, got ${statuses.length}`,
            ),
          );
        }
        const entry = statuses[0]!;
        if (entry.agentId !== a.agentId || entry.status !== "online") {
          return yield* Effect.fail(
            presenceViolation(
              NAME,
              `expected { agentId: ${a.agentId}, status: online }, got ${JSON.stringify(entry)}`,
            ),
          );
        }
      }).pipe(Effect.withSpan("registerSubscribeAfterConnect")),
    ),
  );
}
