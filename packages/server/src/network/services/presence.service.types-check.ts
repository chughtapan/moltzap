/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors message-send-permission.types-check.ts convention). */
/* eslint-disable jsdoc/text-escaping -- the canary doc literally cites `Effect<void, never, never>` as a type expression in prose; escaping the angle brackets would render them as escape codes in rendered docs. */

/**
 * Type-canary for the consolidated `PresenceService` contract. Asserts:
 *
 * 1. **Public surface shape** — `PresenceService` exposes the
 *    subscriber registry, the status-engine lifecycle/observer methods,
 *    and the status readers; the pure helpers + types come from
 *    `presence-types.ts`. Direct-annotation form
 *    (`const _check: T = x; void _check;`) instead of `void (x as T)`
 *    so widening triggers TS2322 (the `as` form permits bidirectional
 *    widening and does NOT catch a relax).
 *
 *    - `DerivedPresenceStatus` is the three-state union.
 *    - `LeaseTransitionObserver` carries the two boundary methods
 *      (begin, end), each producing `Effect<void, never, never>`, with
 *      a third `recipientConnId: ConnectionId` parameter (the
 *      fast-reconnect-race guard).
 *    - `noopLeaseTransitionObserver` is a default-shaped observer.
 *    - `PresenceService` IS-A `LeaseTransitionObserver` and adds
 *      `onAgentConnect(agentId, connId)` /
 *      `onAgentDisconnect(agentId, connId)` plus `statusOf` /
 *      `statusMany` plus the subscriber-registry CRUD
 *      (`subscribe` / `getSubscribers` / `removeConnection`).
 *    - `dedupePresenceStatus` is a pure
 *      `(prev, next) => Option` of the status union.
 *    - `deriveEntryStatus` is the lease-count-to-status helper.
 *    - `PresenceAuditEvent` is the discriminated union for "expected
 *      during teardown" lease callbacks.
 *    - `PresenceService.make` returns
 *      `Effect<PresenceService, never, never>`.
 *
 * 2. **Module-privacy seal at `presence.service.ts`** — three
 *    `@ts-expect-error` assertions guarantee the wire-emission
 *    internals (the fan-out sink, the per-frame writer, and a status
 *    CAS predicate) are NOT exported from `presence.service.ts`. Any
 *    `import { fanOut | publishOneFrame | computeObserverTransition }`
 *    from `./presence.service.js` MUST fail with TS2305 "Module has no
 *    exported member". If any assertion stops firing, the seal has been
 *    broken (someone added `export`) and `tsc --build` fails with
 *    "Unused `@ts-expect-error` directive" until the export is removed.
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */
import type { Effect, Option } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol/message";
import type { ConnectionId } from "@moltzap/protocol/socket";

import type {
  AgentPresenceEntry,
  DerivedPresenceStatus,
  LeaseTransitionObserver,
  PresenceAuditEvent,
  PresenceEmission,
} from "./presence-types.js";
import {
  deriveEntryStatus,
  dedupePresenceStatus,
  noopLeaseTransitionObserver,
} from "./presence-types.js";
import { PresenceService } from "./presence.service.js";

// ── 1. Public surface direct-annotation assertions ──────────────────

declare const status: DerivedPresenceStatus;
const _statusCheck: "online" | "working" | "offline" = status;
void _statusCheck;

declare const observer: LeaseTransitionObserver;
declare const presence: PresenceService;
const _serviceIsObserver: LeaseTransitionObserver = presence;
void _serviceIsObserver;
void observer.onLeaseActiveBegin;
void observer.onLeaseActiveEnd;
void presence.onAgentConnect;
void presence.onAgentDisconnect;
void presence.statusOf;
void presence.statusMany;
void presence.subscribe;
void presence.getSubscribers;
void presence.removeConnection;

declare const observerCallback: LeaseTransitionObserver["onLeaseActiveBegin"];
const _observerArity: (
  leaseId: LeaseId,
  recipientAgentId: AgentId,
  recipientConnId: ConnectionId,
) => Effect.Effect<void, never, never> = observerCallback;
void _observerArity;

declare const connectCallback: PresenceService["onAgentConnect"];
const _connectArity: (
  agentId: AgentId,
  connId: ConnectionId,
) => Effect.Effect<void, never, never> = connectCallback;
void _connectArity;

// noop observer satisfies the observer surface and is usable as the
// LeaseRegistry's transitionObserver default (no nullable branch).
const _noopIsObserver: LeaseTransitionObserver = noopLeaseTransitionObserver;
void _noopIsObserver;

declare const emitResult: ReturnType<typeof dedupePresenceStatus>;
const _emitResultCheck: Option.Option<DerivedPresenceStatus> = emitResult;
void _emitResultCheck;

declare const derivedStatus: ReturnType<typeof deriveEntryStatus>;
const _derivedStatusCheck: Exclude<DerivedPresenceStatus, "offline"> =
  derivedStatus;
void _derivedStatusCheck;

declare const factoryResult: ReturnType<typeof PresenceService.make>;
const _factoryResultCheck: Effect.Effect<PresenceService, never, never> =
  factoryResult;
void _factoryResultCheck;

declare const emission: PresenceEmission;
void emission.agentId;
void emission.status;

declare const entry: AgentPresenceEntry;
// Multi-connection-shaped entry: `liveConns` carries the set of all
// simultaneous WS connections and `leasesByConn` maps each live
// connection to the leases bound to it.
void entry.liveConns;
void entry.leasesByConn;
// Status is derived via deriveEntryStatus(entry); the entry holds no
// stored `status` field. Asserting the absence structurally: any
// access to entry.status fails TypeScript (TS2339). The
// `@ts-expect-error` below MUST fire today — if a future contributor
// re-adds `status` to the entry, the directive becomes unused and
// `tsc --build` fails with TS2578.
// @ts-expect-error — AgentPresenceEntry has no `status` field; status is derived via deriveEntryStatus(entry).
void entry.status;
// @ts-expect-error — AgentPresenceEntry has no single-conn `connId` field; the agent tracks a set of liveConns + per-conn lease buckets.
void entry.connId;
// @ts-expect-error — AgentPresenceEntry has no flat `activeLeases` set; per-conn lease buckets in leasesByConn replace it.
void entry.activeLeases;

// PresenceAuditEvent discriminated union for "expected during
// teardown" lease callbacks. Discriminator exhaustiveness —
// `absurdCheck` is a type-level assertion that every variant has been
// handled; a fourth variant fails the assignment to `never`.
declare const audit: PresenceAuditEvent;
void audit.agentId;
void audit.leaseId;
const auditTag = audit._tag;
declare function absurdCheck(x: never): never;
if (
  auditTag !== "LeaseEndAfterDisconnect" &&
  auditTag !== "LeaseBeginAfterDisconnect" &&
  auditTag !== "LeaseCallbackFromStaleConnection"
) {
  absurdCheck(auditTag);
}

// ── 2. Module-privacy seal at `presence.service.ts` ─────────────────
//
// THREE assertions assert the wire-emission internals are NOT exported
// from `presence.service.ts`. The fan-out sink (`fanOut`), the
// per-frame writer (`publishOneFrame`), and a status CAS predicate
// (`computeObserverTransition`) are module-private. If any assertion
// stops failing, the seal has been broken (someone added `export`) and
// `tsc --build` fails with "Unused @ts-expect-error directive" until
// the export is removed.

// @ts-expect-error — seal #1: `fanOut` is module-private to `presence.service.ts`. If this stops firing, the fan-out sink leaked.
import { fanOut as sealFanOut } from "./presence.service.js";
void sealFanOut;

// @ts-expect-error — seal #2: `publishOneFrame` is module-private to `presence.service.ts`. If this stops firing, the per-frame writer leaked.
import { publishOneFrame as sealPublishOneFrame } from "./presence.service.js";
void sealPublishOneFrame;

// @ts-expect-error — seal #3: `computeObserverTransition` is module-private to `presence.service.ts`. If this stops firing, the status CAS predicate leaked.
import { computeObserverTransition as sealComputeObserver } from "./presence.service.js";
void sealComputeObserver;
