/**
 * Network-layer delivery primitive (arch-G).
 *
 * `DeliveryService.send(to, payload)` is the ONE delivery method exposed by
 * the network layer. It resolves `to` through `ConnectionManager.lookup`,
 * then enqueues the payload onto the endpoint's queue under its
 * `BackpressurePolicy`. No fan-out primitive — callers iterate with
 * `Effect.forEach(participants, (to) => send(to, …))`. See spec Invariant 6.
 *
 * Transport errors (socket write failures, webhook non-2xx, etc.) never
 * leak to the caller: the endpoint's drain fiber catches them, logs, and
 * the endpoint's scope is closed. `send` fails only with the errors named
 * in `DeliveryError`.
 *
 * Replaces `packages/server/src/ws/broadcaster.ts` — which is fan-out + fork
 * + silent catch — with a typed, non-fan-out `send` primitive. The
 * broadcaster module is listed for removal in the arch-G design doc
 * (§ "files to remove at implement-* time").
 */

import type { Effect } from "effect";
import type { EventFrame } from "@moltzap/protocol/network";
import type {
  EndpointAddress,
  EndpointNotRegistered,
  ConnectionManagerTag,
} from "./connection-manager.js";

/* ── Backpressure policy (closed union) ────────────────────────────────── */

/**
 * How a full endpoint queue behaves on enqueue. Closed discriminated union —
 * `default` in an exhaustive match is `absurd(x: never)`. Chosen per
 * endpoint at registration time; the network layer has no global fallback
 * (every endpoint names its own).
 *
 * Semantics:
 *   - `Fail`         — `send` fails with `BackpressureExceeded`. Caller
 *                      decides whether to drop, retry, or queue upstream.
 *   - `DropOldest`   — oldest queued frame is discarded; new frame is
 *                      enqueued. `send` succeeds.
 *   - `Block`        — `send` suspends until the queue has capacity or the
 *                      endpoint is unregistered (which interrupts).
 */
export type BackpressurePolicy =
  | { readonly _tag: "Fail"; readonly maxQueueDepth: number }
  | { readonly _tag: "DropOldest"; readonly maxQueueDepth: number }
  | { readonly _tag: "Block"; readonly maxQueueDepth: number };

/* ── DeliveryService service ───────────────────────────────────────────── */

/**
 * The single delivery primitive at the network layer. `payload` is an
 * `EventFrame` — the network-wire envelope. The network layer treats the
 * contents as opaque beyond the envelope; parsing happens at the task
 * manager (spec Invariant 3).
 *
 * Requires `ConnectionManagerTag` to resolve addresses. Implemented over
 * `ConnectionManager.lookup` + the endpoint's `Queue` and
 * `BackpressurePolicy`.
 */
export interface DeliveryService {
  readonly send: (
    to: EndpointAddress,
    payload: EventFrame,
  ) => Effect.Effect<void, DeliveryError, ConnectionManagerTag>;
}

/** Context tag for {@link DeliveryService}. */
export declare const DeliveryServiceTag: import("effect").Context.Tag<
  DeliveryServiceTag,
  DeliveryService
>;
export interface DeliveryServiceTag {
  readonly _: unique symbol;
}

/* ── Tagged errors ─────────────────────────────────────────────────────── */

/**
 * Enqueue failed because the endpoint's queue was at `maxQueueDepth` and the
 * endpoint's policy is `Fail`. Deterministic failure — the caller sees this
 * instead of a dropped frame.
 */
export class BackpressureExceeded {
  readonly _tag = "BackpressureExceeded" as const;
  constructor(
    readonly address: EndpointAddress,
    readonly policy: BackpressurePolicy,
  ) {
    throw new Error("not implemented");
  }
}

/**
 * The endpoint's drain fiber failed to write to the transport and the
 * endpoint has been torn down. `send` after a transport failure sees this
 * only for a brief window before `unregister` runs; most callers will see
 * `EndpointNotRegistered` instead. Kept as a distinct tag so observability
 * can distinguish transport-induced teardown from explicit `unregister`.
 */
export class DeliveryTransportFailed {
  readonly _tag = "DeliveryTransportFailed" as const;
  constructor(
    readonly address: EndpointAddress,
    readonly cause: unknown,
  ) {
    throw new Error("not implemented");
  }
}

/**
 * Closed discriminated union of `send` failures. Every caller discriminates
 * on `_tag`.
 *
 *   - `EndpointNotRegistered`   — address unknown (from `ConnectionManager.lookup`).
 *   - `BackpressureExceeded`    — queue full; `Fail` policy.
 *   - `DeliveryTransportFailed` — transport I/O failed; endpoint is being torn down.
 */
export type DeliveryError =
  | EndpointNotRegistered
  | BackpressureExceeded
  | DeliveryTransportFailed;

/* ── Not-implemented stub bodies ───────────────────────────────────────── */

/** Constructor stub. The implement-* pass builds this over
 *  `ConnectionManager.lookup` + `Queue.offer` / `Queue.unsafeOffer`
 *  depending on `BackpressurePolicy`. */
export declare const makeDeliveryService: () => Effect.Effect<
  DeliveryService,
  never,
  ConnectionManagerTag
>;
