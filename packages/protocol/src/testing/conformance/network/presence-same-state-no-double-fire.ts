/**
 * Re-sending network/connect on an already-authenticated WS short-circuits
 * to buildHelloOk (`auth.handlers.ts:71`) which calls setOnline again.
 * The idempotency guard MUST suppress the redundant broadcast.
 */
import { Effect } from "effect";
import { PROTOCOL_VERSION } from "../../../version.js";
import { Connect } from "@moltzap/protocol/network";
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

export function registerSameStateNoDoubleFire(
  ctx: ConformanceRunContext,
): void {
  const NAME = "same-state-no-double-fire";
  registerProperty(
    ctx,
    PRESENCE_CATEGORY,
    NAME,
    "redundant setOnline (network/connect on already-authenticated WS) does NOT double-fire presence/changed",
    Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* acquireClient(ctx, NAME, "p4-sub");
        const a = yield* registerAgent(ctx, NAME, "p4-a");
        yield* subscribePresence(sub.client, a.agentId, NAME);
        const aClient = yield* acquireCloseableClient(
          ctx,
          NAME,
          a,
          "p4-a-client",
        );
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );

        yield* aClient
          .sendRpc(Connect, {
            agentKey: a.apiKey,
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
          })
          .pipe(
            Effect.mapError((e) =>
              presenceViolation(
                NAME,
                `network/connect re-send failed: ${String(e)}`,
              ),
            ),
          );

        // Stabilization window — give a regression a chance to land.
        yield* Effect.sleep("250 millis");
        const count = yield* countPresenceChangedFor(sub.client, a.agentId);
        if (count !== 1) {
          return yield* Effect.fail(
            presenceViolation(
              NAME,
              `expected 1 event for ${a.agentId}, observed ${count}`,
            ),
          );
        }
      }),
    ),
  );
}
