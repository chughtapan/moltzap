/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors message-send-permission.types-check.ts convention). */

/**
 * Integration-surface type-canary for the presence-projection
 * architect plan (#706 v3 — codex r2 P2 #6 fix).
 *
 * Where {@link presence-projection.types-check.ts} asserts the
 * PROJECTION MODULE's own surface, THIS file asserts the
 * INTEGRATION-POINT contracts the plan §3 / §4 cite — the existing
 * server symbols that impl-staff threads the projection through in
 * the §8 cutover.
 *
 * The canary's job is to make a `tsc --build` failure surface the
 * moment any of these integration symbols changes shape on `main` in
 * a way that would break the impl-staff PR. The plan can't enforce
 * the integration at the architect tier (the impl-staff PR is what
 * touches `lease-registry.ts` + `app/layers.ts` + the consumer
 * handlers), but this canary makes the upstream prerequisites
 * load-bearing in `tsc --build`:
 *
 * 1. **`PresenceServiceTag` exposes `getSubscribers(agentId)`** so the
 *    projection can adapt it to `PresenceSubscriberRegistry`.
 * 2. **`ConnectionManagerTag` exposes `get(connId)`** (the surface the
 *    internal sink uses to write `presence/changed` frames).
 * 3. **`LeaseRegistryDeps` is the shape the projection's observer
 *    plugs into** — the v3 plan cites
 *    `LeaseRegistryDeps.transitionObserver` as the new dep field
 *    (architect adds this on the same branch per codex r3 P2 #3 fix
 *    so the integration boundary is asserted at architect tier). The
 *    canary now asserts the `transitionObserver` field directly is
 *    assignable from `LeaseTransitionObserver` (and that the
 *    `noopLeaseTransitionObserver` constant satisfies the field), plus
 *    asserts the SIBLING fields (`connections`, `leaseRetentionMs`)
 *    are still on the type so a future refactor that drops one of
 *    those without updating the plan surfaces here.
 *
 * The `PresenceProjectionTag` is NOT asserted in this file because
 * the Tag class doesn't exist yet — impl-staff declares it in
 * `app/layers.ts`. The plan §3 / §5 names the Tag; the architect
 * stubs in `presence-projection.ts` do NOT declare a Tag (per
 * safer-by-default architect SKILL.md: stubs are signatures + JSDoc,
 * NOT control flow). The integration assertion below confirms the
 * UPSTREAM shapes the Tag will compose against.
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */

import type { PresenceService } from "./presence.service.js";
import type { ConnectionManager } from "../../transport/connection.js";
import type { LeaseRegistryDeps } from "../../task/leases/lease-registry.js";

import type {
  LeaseTransitionObserver,
  PresenceSubscriberRegistry,
  PresenceProjectionDeps,
} from "./presence-projection.js";
import { noopLeaseTransitionObserver } from "./presence-projection.js";

// ── 1. PresenceServiceTag → PresenceSubscriberRegistry adapter ───────
//
// The projection's `deps.subscribers` field is typed
// `PresenceSubscriberRegistry`. impl-staff will pass `presenceService`
// (after the v3 surface narrowing — see §8) which still exposes
// `getSubscribers(agentId): ReadonlySet<ConnectionId>`. The canary
// asserts the existing `PresenceService.getSubscribers` signature
// satisfies the adapter shape; if `PresenceService.getSubscribers`
// changes return type, this fails.
declare const presenceService: PresenceService;
const _serviceAsSubscribers: PresenceSubscriberRegistry = {
  getSubscribers: (agentId) => presenceService.getSubscribers(agentId),
};
void _serviceAsSubscribers;

// ── 2. ConnectionManagerTag → PresenceProjectionDeps.connections ─────
//
// The projection's deps carry `connections: ConnectionManager`
// directly. The canary just asserts the type is structurally
// assignable — no adapter needed — and that the `.get(connId)` method
// (which the internal sink will call) is present on the type.
declare const connections: ConnectionManager;
declare const subscribers: PresenceSubscriberRegistry;
const _depsConstruction: PresenceProjectionDeps = {
  subscribers,
  connections,
};
void _depsConstruction;
void connections.get;

// ── 3. LeaseRegistryDeps shape ──────────────────────────────────────
//
// The v4 plan §2 module #2 (codex r3 P2 #3 + P3 #1 fix) makes
// `transitionObserver: LeaseTransitionObserver` a REQUIRED field on
// `LeaseRegistryDeps` (chose option (b) over (a) — required is
// structurally tighter than optional + default, and aligns with the
// no-weak-shared-classes pattern). The architect lands the field on
// the SAME branch as the projection stub so the integration boundary
// is canary-asserted at architect tier; impl-staff fills the body
// + threads the real `PresenceProjectionTag` at composition root.
declare const leaseRegistryDeps: LeaseRegistryDeps;
void leaseRegistryDeps.connections;
void leaseRegistryDeps.leaseRetentionMs;
const _observerField: LeaseTransitionObserver =
  leaseRegistryDeps.transitionObserver;
void _observerField;
// noop constant satisfies the field at every test / production call
// site that does not have a projection (until impl-staff threads
// `PresenceProjectionTag` per §8).
const _noopSatisfiesField: LeaseTransitionObserver =
  noopLeaseTransitionObserver;
void _noopSatisfiesField;

// ── 4. PresenceProjectionLive integration (v7 / codex r6 P2 #3) ────
//
// v7 deletes the type-only `declare const PresenceProjectionLive` in
// `presence-projection.ts` (it had no runtime binding — any consumer
// would crash) and re-declares it in `app/layers.ts` as a real
// `Layer.effect(PresenceProjectionTag, ...)` value. The canary
// asserts:
//
// - `PresenceProjectionLive` is a Layer whose output type is
//   `PresenceProjectionTag` (single source-of-truth for the
//   integration boundary; if impl-staff degrades the output type,
//   the assignment fails TS2322).
// - The Layer's RIn channel consumes `PresenceServiceTag |
//   ConnectionManagerTag` (the projection's `subscribers` +
//   `connections` deps).

import {
  PresenceProjectionLive,
  type PresenceServiceTag,
  type ConnectionManagerTag,
} from "../../app/layers.js";
import type { PresenceProjectionTag } from "./presence-projection.js";
import type { Layer } from "effect";

declare const projectionLive: typeof PresenceProjectionLive;
const _projectionLiveShape: Layer.Layer<
  PresenceProjectionTag,
  never,
  PresenceServiceTag | ConnectionManagerTag
> = projectionLive;
void _projectionLiveShape;
