/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors message-send-permission.types-check.ts convention). */

/**
 * Type-canary for the consolidated `PresenceService` contract. Asserts:
 *
 * 1. **Public surface shape** — `PresenceService` exposes the
 *    status-engine lifecycle/observer methods and the status readers;
 *    the pure helpers + types come from `presence-types.ts`.
 *    Direct-annotation form
 *    (`const _check: T = x; void _check;`) instead of `void (x as T)`
 *    so widening triggers TS2322 (the `as` form permits bidirectional
 *    widening and does NOT catch a relax).
 *
 *    - `DerivedPresenceStatus` is the three-state union.
 *    - `LeaseTransitionObserver` carries the two boundary methods
 *      (begin, end), each producing an Effect that cannot fail and
 *      needs no environment, with a third `recipientConnId` parameter (the
 *      fast-reconnect-race guard).
 *    - `noopLeaseTransitionObserver` is a default-shaped observer.
 *    - `PresenceService` IS-A `LeaseTransitionObserver` and adds
 *      `onAgentConnect(agentId, connId)` /
 *      `onAgentDisconnect(agentId, connId)` plus `statusOf` /
 *      `statusMany`.
 *    - `deriveEntryStatus` is the lease-count-to-status helper.
 *    - `PresenceAuditEvent` is the discriminated union for "expected
 *      during teardown" lease callbacks.
 *    - `PresenceService.make` returns
 *      an Effect that yields `PresenceService`, cannot fail, and needs no
 *      environment.
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */
import type { Effect } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";
import type { ConnectionId } from "@moltzap/protocol/socket";

import {
  type AgentPresenceEntry,
  type DerivedPresenceStatus,
  type LeaseTransitionObserver,
  type PresenceAuditEvent,
  type deriveEntryStatus,
  noopLeaseTransitionObserver,
} from "./presence-types.js";
import type { PresenceService } from "./presence.service.js";

// ── 1. Public surface direct-annotation assertions ──────────────────

declare const status: DerivedPresenceStatus;
const statusCheck: "online" | "working" | "offline" = status;
void statusCheck;

declare const observer: LeaseTransitionObserver;
declare const presence: PresenceService;
const serviceIsObserver: LeaseTransitionObserver = presence;
void serviceIsObserver;
void observer.onLeaseActiveBegin;
void observer.onLeaseActiveEnd;
void presence.onAgentConnect;
void presence.onAgentDisconnect;
void presence.statusOf;
void presence.statusMany;

declare const observerCallback: LeaseTransitionObserver["onLeaseActiveBegin"];
const observerArity: (
  leaseId: LeaseId,
  recipientAgentId: AgentId,
  recipientConnId: ConnectionId,
) => Effect.Effect<void> = observerCallback;
void observerArity;

declare const connectCallback: PresenceService["onAgentConnect"];
const connectArity: (
  agentId: AgentId,
  connId: ConnectionId,
) => Effect.Effect<void> = connectCallback;
void connectArity;

// noop observer satisfies the observer surface and is usable as the
// LeaseRegistry's transitionObserver default (no nullable branch).
const noopIsObserver: LeaseTransitionObserver = noopLeaseTransitionObserver;
void noopIsObserver;

declare const derivedStatus: ReturnType<typeof deriveEntryStatus>;
const derivedStatusCheck: Exclude<DerivedPresenceStatus, "offline"> =
  derivedStatus;
void derivedStatusCheck;

declare const factoryResult: ReturnType<typeof PresenceService.make>;
const factoryResultCheck: Effect.Effect<PresenceService> = factoryResult;
void factoryResultCheck;

declare const entry: AgentPresenceEntry;
// Multi-connection-shaped entry: `liveConns` carries the set of all
// simultaneous WS connections and `leasesByConn` maps each live
// connection to the leases bound to it.
void entry.liveConns;
void entry.leasesByConn;

type ExpectFalse<Value extends false> = Value;
type EntryHasNoStoredStatus = ExpectFalse<
  "status" extends keyof AgentPresenceEntry ? true : false
>;
type EntryHasNoSingleConnection = ExpectFalse<
  "connId" extends keyof AgentPresenceEntry ? true : false
>;
type EntryHasNoFlatLeaseSet = ExpectFalse<
  "activeLeases" extends keyof AgentPresenceEntry ? true : false
>;

/** Compile-time assertions for fields intentionally absent from presence state. */
export type PresenceEntryAbsenceCanaries = [
  EntryHasNoStoredStatus,
  EntryHasNoSingleConnection,
  EntryHasNoFlatLeaseSet,
];

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

/* eslint-enable sonarjs/void-use -- Restore strict defaults after the scoped file-level exception. -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. */
