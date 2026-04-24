/**
 * Client-side delivery properties.
 *
 * Covers spec-amendment #200 §5:
 *   C1 — fan-out-cardinality (client-side new)
 *   C3 — payload-opacity (client-side new)
 *   C4 — task-boundary-isolation (client half of both-sides)
 *
 * Handshake-noise guard (O7): every observation filters by
 * `emissionTag`. C1 tags each of N emissions with a shared campaign
 * id; predicate asserts exactly N observed frames with that campaign
 * id. C3 tags the one emission; predicate finds exactly one observed
 * frame carrying the byte-identical payload. C4 tags task-A and
 * task-B emissions with distinct campaigns; task-A subscriber must
 * observe zero task-B campaign emissions.
 *
 * Exact-cardinality discipline (#195 §P1 on server-side C1 carries
 * over): `observedCount === N`, not `≥ 1` and not `≤ N`. Duplicates
 * and drops fail symmetrically.
 */
import type { ClientConformanceRunContext } from "./runner.js";

/**
 * C1 client-side — TestServer emits N fan-out `EventFrame`s (one
 * per conversation participant position) to a real client subscribed
 * to the conversation. All N carry the same `emissionTag`
 * `campaignId`; each carries a per-position `positionIndex` in the
 * payload.
 *
 * Predicate (conjunction):
 *   - `observedByCampaign.length === N`
 *   - every `positionIndex` in `[0..N)` appears exactly once
 *   - observation order matches emission order (strict sequence
 *     preservation on the client's public subscriber stream)
 *
 * Discriminates: a client that coalesces duplicate fan-out frames,
 * drops one, or emits subscriber callbacks in arrival-time-interleaved
 * order when the server sent them sequentially fails.
 */
export function registerFanOutCardinalityClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}

/**
 * C3 client-side — TestServer emits an `EventFrame` whose payload
 * contains an arbitrary byte sequence (generated via fast-check).
 * Real client's subscriber surfaces the byte-identical payload.
 *
 * Predicate (strict): `observed.rawBytes` is byte-for-byte equal to
 * the emitted payload bytes. No base64 re-encode, no charset drift,
 * no JSON re-serialization that re-orders keys before re-emission.
 *
 * Discriminates: a client that routes payloads through
 * `JSON.stringify(JSON.parse(...))` (key reorder) fails. A client
 * that normalizes unicode fails.
 */
export function registerPayloadOpacityClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}

/**
 * C4 client half — TestServer emits N task-A events (tagged
 * `campaignA`) and M task-B events (tagged `campaignB`) to a real
 * client subscribed only to task A. The client's task-A subscriber
 * surfaces zero `campaignB` events.
 *
 * Predicate: `observedCampaignB.length === 0`.
 *
 * Discriminates: a client whose subscription filter is a no-op (all
 * events fan out to all subscribers) fails. Any task-B leak is a
 * failure regardless of server-side or client-side responsibility
 * split — the predicate makes no claim about *where* the filter
 * happens.
 */
export function registerTaskBoundaryIsolationClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}
