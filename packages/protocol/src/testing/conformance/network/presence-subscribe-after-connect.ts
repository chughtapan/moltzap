/**
 * Subscribing AFTER an agent connects ⇒ snapshot reflects status: online.
 */
import { Effect } from "effect";
import { agentPresenceSubscribe } from "#network";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  PRESENCE_CATEGORY,
  acquireClient,
  acquireCloseableClient,
  presenceViolation,
  registerAgent,
  type PresenceStatusEntry,
} from "./_helpers.js";

/**
 * Registers subscribe after connect.
 * @param ctx Context for the operation.
 */
export function registerSubscribeAfterConnect(
  ctx: ConformanceRunContext,
): void {
  const name = "subscribe-after-connect";
  registerProperty(
    ctx,
    PRESENCE_CATEGORY,
    name,
    "subscribing AFTER an agent connects ⇒ snapshot reflects status: online",
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* registerAgent(ctx, name, "p6-a");
        yield* acquireCloseableClient(ctx, name, a, "p6-a-client");

        const sub = yield* acquireClient(ctx, name, "p6-sub");
        const result = yield* sub.client
          .sendRpc(agentPresenceSubscribe, { agentIds: [a.agentId] })
          .pipe(
            Effect.mapError((e) =>
              presenceViolation(
                name,
                `network/presence/subscribe failed: ${String(e)}`,
              ),
            ),
          );
        const statuses: readonly PresenceStatusEntry[] = result.statuses;
        if (statuses.length !== 1) {
          return yield* Effect.fail(
            presenceViolation(
              name,
              `expected 1 status entry, got ${statuses.length}`,
            ),
          );
        }
        const entry = statuses[0]!;
        if (entry.agentId !== a.agentId || entry.status !== "online") {
          return yield* Effect.fail(
            presenceViolation(
              name,
              `expected { agentId: ${a.agentId}, status: online }, got ${JSON.stringify(entry)}`,
            ),
          );
        }
      }).pipe(Effect.withSpan("registerSubscribeAfterConnect")),
    ),
  );
}
