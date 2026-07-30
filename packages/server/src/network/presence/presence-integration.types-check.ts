/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors message-send-permission.types-check.ts convention). */

/**
 * Integration-surface type-canary for `PresenceService`.
 *
 * Where {@link presence.service.types-check.ts} asserts the service's
 * OWN surface, THIS file asserts the INTEGRATION-POINT contracts the
 * service threads through: the server symbols it composes against at the
 * lease-registry boundary and the composition root.
 *
 * The canary makes a `tsc --build` failure surface the moment any of
 * these integration symbols changes shape in a way that would break the
 * wiring:
 *
 * 1. **`LeaseRegistryDeps.transitionObserver`** is assignable from
 *    `LeaseTransitionObserver` (and `noopLeaseTransitionObserver`
 *    satisfies it); the sibling fields (`connections`,
 *    `leaseRetentionMs`) stay on the type so a future refactor that
 *    drops one without updating the wiring surfaces here.
 * 2. **`PresenceServiceLive`** is a Layer whose output is
 *    `PresenceServiceTag` and whose RIn channel is closed. The
 *    registry consumes `PresenceServiceTag` as its `transitionObserver`,
 *    so the service graph stays sound.
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */

import type { PresenceService } from "./presence.service.js";
import type { LeaseRegistryDeps } from "#dispatch";

import {
  type LeaseTransitionObserver,
  noopLeaseTransitionObserver,
} from "./presence-types.js";

declare const presenceService: PresenceService;

// ── 1. LeaseRegistryDeps shape ──────────────────────────────────────
//
// `transitionObserver: LeaseTransitionObserver` is a REQUIRED field on
// `LeaseRegistryDeps`. The service satisfies it (it IS-A observer); the
// noop constant satisfies it for tests that do not exercise presence.
declare const leaseRegistryDeps: LeaseRegistryDeps;
void leaseRegistryDeps.connections;
void leaseRegistryDeps.leaseRetentionMs;
const observerField: LeaseTransitionObserver =
  leaseRegistryDeps.transitionObserver;
void observerField;
const serviceSatisfiesField: LeaseTransitionObserver = presenceService;
void serviceSatisfiesField;
const noopSatisfiesField: LeaseTransitionObserver = noopLeaseTransitionObserver;
void noopSatisfiesField;

// ── 2. PresenceServiceLive integration ──────────────────────────────
//
// `PresenceServiceLive` outputs `PresenceServiceTag` and is fully closed. If
// the construction dep set changes, the assignment fails TS2322.

import type {
  presenceServiceLive as presenceServiceLiveLayer,
  PresenceServiceTag,
} from "#network/presence";
import type { Layer } from "effect";

declare const presenceServiceLive: typeof presenceServiceLiveLayer;
const presenceServiceLiveShape: Layer.Layer<PresenceServiceTag> =
  presenceServiceLive;
void presenceServiceLiveShape;

/* eslint-enable sonarjs/void-use -- Restore strict defaults after the scoped file-level exception. -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. */
