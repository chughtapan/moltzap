/**
 * Spurious appCallback responses do not crash or poison the server. Architect
 * plan §3.3 + §1.7: the server's `appCallbackPending` map keys on the request id
 * it allocated; an inbound appCallback response with no matching pending entry
 * is dropped, the connection stays responsive.
 *
 * Phase 1A architect §5 disposition: RETOMBSTONE — verifying that
 * `TestClient.sendMalformed` exposes the wire-level injection seam and
 * writing the property body is implementer-tier behavior, outside Phase
 * 1A's structural scope.
 */
import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyDeferred, registerProperty } from "../_shared/registry.js";

const CATEGORY = "rpc-semantics" as const;
const PROPERTY = "spurious-app-callback-frame-handling";

export function registerSpuriousAppCallbackFrameHandling(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "stray appCallback response with no matching pending ⇒ server drops & stays alive",
    Effect.fail(
      new PropertyDeferred({
        category: CATEGORY,
        name: PROPERTY,
        followUp:
          "wire-level raw-frame injection requires TestClient extension; #557 covers via server-side fault injection (B.9 integration tier)",
      }),
    ).pipe(Effect.withSpan("registerSpuriousAppCallbackFrameHandling")),
  );
}
