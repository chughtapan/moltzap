/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors message-send-permission.types-check.ts convention). */

/**
 * Integration-surface type-canary for `PresenceService`.
 *
 * Where {@link presence.service.types-check.ts} asserts the service's
 * OWN surface, THIS file asserts the INTEGRATION-POINT contracts the
 * service threads through: the existing server symbols it composes
 * against at the lease-registry seam and the composition root.
 *
 * The canary makes a `tsc --build` failure surface the moment any of
 * these integration symbols changes shape in a way that would break the
 * wiring:
 *
 * 1. **`PresenceService` IS the subscriber registry** — `getSubscribers`
 *    + `subscribe` + `removeConnection` live on the same instance the
 *    fan-out reads.
 * 2. **`ConnectionManager.get(connId)`** — the surface the fan-out uses
 *    to write `presence/changed` frames.
 * 3. **`LeaseRegistryDeps.transitionObserver`** is assignable from
 *    `LeaseTransitionObserver` (and `noopLeaseTransitionObserver`
 *    satisfies it); the sibling fields (`connections`,
 *    `leaseRetentionMs`) stay on the type so a future refactor that
 *    drops one without updating the wiring surfaces here.
 * 4. **`PresenceServiceLive`** is a Layer whose output is
 *    `PresenceServiceTag` and whose RIn channel consumes
 *    `ConnectionManagerTag` (the service's sole construction dep). The
 *    registry consumes `PresenceServiceTag` as its `transitionObserver`,
 *    so the Tier graph stays sound.
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */

import type { PresenceService } from "./presence.service.js";
import type { ConnectionManager } from "../../transport/connection.js";
import type { LeaseRegistryDeps } from "../../task/leases/lease-registry.js";

import type { LeaseTransitionObserver } from "./presence-types.js";
import { noopLeaseTransitionObserver } from "./presence-types.js";

// ── 1. PresenceService owns the subscriber registry ─────────────────
declare const presenceService: PresenceService;
void presenceService.getSubscribers;
void presenceService.subscribe;
void presenceService.removeConnection;

// ── 2. ConnectionManager.get ────────────────────────────────────────
declare const connections: ConnectionManager;
void connections.get;

// ── 3. LeaseRegistryDeps shape ──────────────────────────────────────
//
// `transitionObserver: LeaseTransitionObserver` is a REQUIRED field on
// `LeaseRegistryDeps`. The service satisfies it (it IS-A observer); the
// noop constant satisfies it for tests that do not exercise presence.
declare const leaseRegistryDeps: LeaseRegistryDeps;
void leaseRegistryDeps.connections;
void leaseRegistryDeps.leaseRetentionMs;
const _observerField: LeaseTransitionObserver =
  leaseRegistryDeps.transitionObserver;
void _observerField;
const _serviceSatisfiesField: LeaseTransitionObserver = presenceService;
void _serviceSatisfiesField;
const _noopSatisfiesField: LeaseTransitionObserver =
  noopLeaseTransitionObserver;
void _noopSatisfiesField;

// ── 4. PresenceServiceLive integration ──────────────────────────────
//
// `PresenceServiceLive` outputs `PresenceServiceTag` and consumes only
// `ConnectionManagerTag`. If the construction dep set changes, the
// assignment fails TS2322.

import {
  PresenceServiceLive,
  type PresenceServiceTag,
  type ConnectionManagerTag,
} from "../../app/layers.js";
import type { Layer } from "effect";

declare const presenceServiceLive: typeof PresenceServiceLive;
const _presenceServiceLiveShape: Layer.Layer<
  PresenceServiceTag,
  never,
  ConnectionManagerTag
> = presenceServiceLive;
void _presenceServiceLiveShape;
