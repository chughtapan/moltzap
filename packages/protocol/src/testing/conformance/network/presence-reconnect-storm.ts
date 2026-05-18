/**
 * Sequential reconnect only. The wait for `offline` between client #1
 * close and client #2 connect is the in-band fence proving the server's
 * onExit reached `setOffline` before the new handshake. Concurrent
 * reconnect (new network/connect races old onExit) is OOS — see OQ6.
 */
import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  PRESENCE_CATEGORY,
  acquireClient,
  acquireCloseableClient,
  presenceStatusesFor,
  presenceViolation,
  registerAgent,
  subscribePresence,
  waitForPresenceWithStatus,
} from "./_helpers.js";

const EXPECTED_PRESENCE_SEQUENCE_LENGTH = 3;

export function registerReconnectStorm(ctx: ConformanceRunContext): void {
  const NAME = "reconnect-storm";
  registerProperty(
    ctx,
    PRESENCE_CATEGORY,
    NAME,
    "online → offline → online lands as three presence/changed events in strict order on a sequential reconnect",
    Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* acquireClient(ctx, NAME, "p3-sub");
        const a = yield* registerAgent(ctx, NAME, "p3-a");
        yield* subscribePresence(sub.client, a.agentId, NAME);

        const c1 = yield* acquireCloseableClient(ctx, NAME, a, "p3-a-client-1");
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );
        yield* c1.close;
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "offline" },
          NAME,
        );

        yield* acquireCloseableClient(ctx, NAME, a, "p3-a-client-2");
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );

        const sequence = yield* presenceStatusesFor(sub.client, a.agentId);
        if (
          sequence.length !== EXPECTED_PRESENCE_SEQUENCE_LENGTH ||
          sequence[0] !== "online" ||
          sequence[1] !== "offline" ||
          sequence[2] !== "online"
        ) {
          return yield* Effect.fail(
            presenceViolation(
              NAME,
              `expected [online, offline, online], got [${sequence.join(", ")}]`,
            ),
          );
        }
      }).pipe(Effect.withSpan("registerReconnectStorm")),
    ),
  );
}
