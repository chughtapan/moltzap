/**
 * Re-sending network/connect on an already-authenticated WS short-circuits
 * to buildHelloOk in `identity/handlers/connect.handlers.ts`, which fires
 * `presenceService.onAgentConnect(agentId, conn.id)` again. The
 * redundant-connect rule handles this: when the incoming connId is
 * already in the agent's `liveConns`, the lifecycle predicate returns
 * `prev === next`, the dedup gate elides, and no `presence/changed` is
 * broadcast. This property asserts the idempotency guard holds.
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
    "redundant onAgentConnect (network/connect on already-authenticated WS) does NOT double-fire presence/changed",
    sameStateNoDoubleFire(ctx, NAME),
  );
}

const sameStateNoDoubleFire = (ctx: ConformanceRunContext, name: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sub = yield* acquireClient(ctx, name, "p4-sub");
      const a = yield* registerAgent(ctx, name, "p4-a");
      yield* subscribePresence(sub.client, a.agentId, name);
      const aClient = yield* acquireCloseableClient(
        ctx,
        name,
        a,
        "p4-a-client",
      );
      yield* waitForPresenceWithStatus(
        sub.client,
        { agentId: a.agentId, status: "online" },
        name,
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
              name,
              `network/connect re-send failed: ${String(e)}`,
            ),
          ),
        );

      yield* Effect.sleep("250 millis");
      const count = yield* countPresenceChangedFor(sub.client, a.agentId);
      if (count !== 1) {
        return yield* Effect.fail(
          presenceViolation(
            name,
            `expected 1 event for ${a.agentId}, observed ${count}`,
          ),
        );
      }
    }).pipe(Effect.withSpan("sameStateNoDoubleFire")),
  );
