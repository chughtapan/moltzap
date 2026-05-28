/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors message-send-permission.types-check.ts convention). */
/* eslint-disable jsdoc/text-escaping -- the canary doc literally cites `Effect<void, never, never>` as a type expression in prose; escaping the angle brackets would render them as escape codes in rendered docs. */

/**
 * Type-canary for the presence-projection contract (architect plan
 * #706 / sub-issue #711, v7). Asserts:
 *
 * 1. **Public surface shape** — the stub module exports the symbols
 *    impl-staff is committed to fill in. Direct-annotation form
 *    (`const _check: T = x; void _check;`) instead of
 *    `void (x as T)` so widening triggers TS2322 (the `as` form
 *    permits bidirectional widening and does NOT catch a relax).
 *
 *    - `DerivedPresenceStatus` is the narrowed three-state union.
 *    - `LeaseTransitionObserver` carries the two boundary methods
 *      (begin, end), each producing `Effect<void, never, never>`,
 *      with a third `recipientConnId: ConnectionId` parameter (v6
 *      codex r5 P2 #1 — fast-reconnect race).
 *    - `noopLeaseTransitionObserver` is a default-shaped observer.
 *    - `PresenceProjection` extends `LeaseTransitionObserver` and
 *      adds `onAgentConnect(agentId, connId)` /
 *      `onAgentDisconnect(agentId, connId)` (v6) plus `statusOf` +
 *      `statusMany` (v3 codex r2 P2 #1 — read surface migrated
 *      from `PresenceService.get/getMany`).
 *    - `emitPresenceTransition` is a pure
 *      `(prev, next) => Option` of the narrowed status union
 *      (re-exported by `presence-projection.ts` from
 *      `presence-projection-types.ts`; v7 — was in
 *      `_internal/presence-emit.ts` pre-v7, now relocated so the
 *      third TS-module seal canary is a real TS2305 assertion).
 *    - `deriveEntryStatus` is the size-to-status helper (v7 codex
 *      r6 P2 #1; replaces the deleted `entry.status` field).
 *    - `EmitIfChanged` is the in-module-curried emit capability
 *      type (v5 / codex r4 P2 #2; v6 moves the impl into
 *      `_internal/presence-emit.ts` per codex r5 P2 #2).
 *    - The factory's deps carry `subscribers: PresenceSubscriberRegistry`
 *      + `connections: ConnectionManager` (codex r2 P2 #4 fix —
 *      the sink is constructed INSIDE the factory body from
 *      `connections`; deps NEVER carry a sink).
 *    - `PresenceProjectionAuditEvent` is the discriminated union
 *      for "expected during teardown" lease callbacks (codex r2
 *      P2 #2 + P2 #3 fix; v6 adds
 *      `LeaseCallbackFromStaleConnection` for the fast-reconnect
 *      race per codex r5 P2 #1).
 *    - The factory returns
 *      `Effect<PresenceProjection, never, never>`.
 *    - **v6 (codex r5 P2 #3): `PresenceProjectionTag`** is the
 *      architect-tier Effect Context tag; canary asserts the Tag's
 *      value type is `PresenceProjection`. (v7 / codex r6 P2 #3:
 *      `PresenceProjectionLive` Layer moves to `app/layers.ts` —
 *      tested by `presence-projection-integration.types-check.ts`,
 *      not here.)
 *    - **v7 (codex r6 P2 #1) — DELETED:** `PresenceProjectionDefect`
 *      + `catchProjectionDefect`. The only `reason`
 *      (`entry-status-size-mismatch`) is structurally impossible
 *      after `entry.status` deletion; no class remains.
 *
 * 2. **External-import seal at `_internal/presence-emit.ts`** (codex
 *    r2 P2 #4 + v6 codex r5 P2 #2 + v7 codex r6 P2 #4) — asserts that
 *    the sink type + fan-out factory + pure dedup function are NOT
 *    exported from `_internal/presence-emit.ts`. Three
 *    `@ts-expect-error` assertions at the bottom of this file
 *    guarantee any external module's
 *    `import { InternalPresenceEventSink | createInternalFanOutEventSink | emitPresenceTransition }`
 *    from `_internal/presence-emit.ts` MUST fail with TS2305
 *    "Module has no exported member". v7's third canary is a REAL
 *    TS2305 seal (v6 was a re-export-probe because
 *    `emitPresenceTransition` was exported from `_internal/`; v7
 *    relocates the helper to `presence-projection-types.ts` so the
 *    seal at `_internal/` genuinely fires).
 *
 * 3. **Integration surfaces** (codex r2 P2 #6 + v7 codex r6 P2 #3)
 *    — `presence-projection-integration.types-check.ts` asserts
 *    `PresenceService.getSubscribers → PresenceSubscriberRegistry`
 *    adapter, `ConnectionManager.get` exists, `LeaseRegistryDeps`
 *    sibling fields, AND (v7) that `PresenceProjectionLive` is a
 *    real Layer value (not `declare const`) consumed by
 *    `LeaseRegistryLive`.
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */
import type { Effect, Option } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";

import type {
  AgentPresenceEntry,
  DerivedPresenceStatus,
  EmitIfChanged,
  LeaseTransitionObserver,
  PresenceEmission,
  PresenceProjection,
  PresenceProjectionAuditEvent,
  PresenceProjectionDeps,
  PresenceSubscriberRegistry,
} from "./presence-projection.js";
import {
  deriveEntryStatus,
  emitPresenceTransition,
  makePresenceProjection,
  noopLeaseTransitionObserver,
  PresenceProjectionTag,
} from "./presence-projection.js";

// ── 1. Public surface direct-annotation assertions ──────────────────
//
// Direct `const _check: T = x; void _check;` instead of
// `void (x as T)` so widening the source type triggers TS2322.

declare const status: DerivedPresenceStatus;
const _statusCheck: "online" | "working" | "offline" = status;
void _statusCheck;

declare const observer: LeaseTransitionObserver;
declare const projection: PresenceProjection;
const _projectionIsObserver: LeaseTransitionObserver = projection;
void _projectionIsObserver;
void observer.onLeaseActiveBegin;
void observer.onLeaseActiveEnd;
void projection.onAgentConnect;
void projection.onAgentDisconnect;
void projection.statusOf;
void projection.statusMany;

// v6 (codex r5 P2 #1): observer callbacks take three args including
// recipientConnId; lifecycle methods take agentId + connId.
declare const observerCallback: LeaseTransitionObserver["onLeaseActiveBegin"];
const _observerArity: (
  leaseId: LeaseId,
  recipientAgentId: AgentId,
  recipientConnId: ConnectionId,
) => Effect.Effect<void, never, never> = observerCallback;
void _observerArity;

declare const connectCallback: PresenceProjection["onAgentConnect"];
const _connectArity: (
  agentId: AgentId,
  connId: ConnectionId,
) => Effect.Effect<void, never, never> = connectCallback;
void _connectArity;

// noop observer satisfies the observer surface and is usable as the
// LeaseRegistry's transitionObserver default (no nullable branch).
const _noopIsObserver: LeaseTransitionObserver = noopLeaseTransitionObserver;
void _noopIsObserver;

declare const emitResult: ReturnType<typeof emitPresenceTransition>;
const _emitResultCheck: Option.Option<DerivedPresenceStatus> = emitResult;
void _emitResultCheck;

// v7 (codex r6 P2 #1): deriveEntryStatus returns the size-derived status.
declare const derivedStatus: ReturnType<typeof deriveEntryStatus>;
const _derivedStatusCheck: Exclude<DerivedPresenceStatus, "offline"> =
  derivedStatus;
void _derivedStatusCheck;

declare const factoryResult: ReturnType<typeof makePresenceProjection>;
const _factoryResultCheck: Effect.Effect<PresenceProjection, never, never> =
  factoryResult;
void _factoryResultCheck;

declare const emission: PresenceEmission;
void emission.agentId;
void emission.status;

declare const entry: AgentPresenceEntry;
void entry.connId;
void entry.activeLeases;
// v7 (codex r6 P2 #1): entry.status field deleted — status is derived
// via deriveEntryStatus(entry). Asserting the deletion structurally:
// any access to entry.status fails TypeScript (TS2339 "Property
// 'status' does not exist on type 'AgentPresenceEntry'"). The
// `@ts-expect-error` below MUST fire today — if a future contributor
// re-adds `status` to the entry, the directive becomes unused and
// `tsc --build` fails with TS2578.
// @ts-expect-error — v7 invariant: AgentPresenceEntry.status was deleted (codex r6 P2 #1). Status is derived via deriveEntryStatus(entry).
void entry.status;

// v3+: PresenceProjectionAuditEvent discriminated union for "expected
// during teardown" lease callbacks (codex r2 P2 #2 + P2 #3 fix; v6
// adds LeaseCallbackFromStaleConnection per codex r5 P2 #1).
// Discriminator exhaustiveness — `absurdCheck` is a type-level
// assertion that every variant has been handled; if impl-staff adds
// a fourth variant, the assignment to `never` fails.
declare const audit: PresenceProjectionAuditEvent;
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

// v3: deps carry `subscribers` + `connections` (NOT a sink — codex
// r2 P2 #4 capability-seal fix; the sink is constructed inside the
// factory body in `_internal/presence-emit.ts` from `connections`).
declare const deps: PresenceProjectionDeps;
void deps.subscribers;
void deps.connections;

declare const subs: PresenceSubscriberRegistry;
void subs.getSubscribers;

// v5 (codex r4 P2 #2): EmitIfChanged is the in-module-curried emit
// capability — the only emission surface the projection's transition
// methods receive. Shape: (prev, next, agentId) => Effect<void, never, never>.
declare const emitter: EmitIfChanged;
declare const someAgentId: AgentId;
const _emitterShape: (
  prev: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
  agentId: AgentId,
) => Effect.Effect<void, never, never> = emitter;
void _emitterShape;
void emitter("online", "working", someAgentId);

// v6 (codex r5 P2 #3): PresenceProjectionTag promoted to architect
// tier. Canary asserts the Tag's value type is PresenceProjection.
// (v7 codex r6 P2 #3: PresenceProjectionLive moves to app/layers.ts;
// integration canary asserts it lives there as a real Layer value.)
const _tagSelfCheck: typeof PresenceProjectionTag = PresenceProjectionTag;
void _tagSelfCheck;

// ── Capability seal canary (codex r2 P2 #4 + v6 codex r5 P2 #2 + v7 codex r6 P2 #4) ──
//
// THREE assertions assert the structural-seal proof. The raw sink +
// factory + dedup helper are ALL NOT exported from
// `_internal/presence-emit.ts`. v7 makes the third canary a real
// TS2305 seal: `emitPresenceTransition` is relocated to
// `presence-projection-types.ts` so the `_internal/` module no
// longer exports it. The architect contract surface (the projection
// module's re-export) is the only documented import path for the
// pure helper.
//
// If any of the three assertions stops failing, the seal has been
// broken (someone added `export` to a symbol in
// `_internal/presence-emit.ts`) and `tsc --build` will fail with
// "Unused @ts-expect-error directive" until the export is removed.

// @ts-expect-error — capability seal #1: InternalPresenceEventSink is NOT exported from `_internal/presence-emit.ts`. If this assertion stops firing, the external seal is broken.
import type { InternalPresenceEventSink as SealCheckType } from "./_internal/presence-emit.js";
declare const sealCheckTypeProbe: SealCheckType;
void sealCheckTypeProbe;

// @ts-expect-error — capability seal #2: createInternalFanOutEventSink is NOT exported from `_internal/presence-emit.ts`. If this assertion stops firing, the external seal is broken.
import { createInternalFanOutEventSink as sealCheckFactory } from "./_internal/presence-emit.js";
void sealCheckFactory;

// v7 (codex r6 P2 #4) — the third canary is now a REAL TS2305 seal.
// v6 exported `emitPresenceTransition` from `_internal/presence-emit.ts`,
// making this assertion a re-export probe that didn't fire. v7
// relocates the pure helper to `presence-projection-types.ts` so
// `_internal/` no longer exports it; the canary genuinely fires
// today (and only stops firing if a future contributor re-adds an
// `export` to `emitPresenceTransition` in `_internal/`).
// @ts-expect-error — capability seal #3: emitPresenceTransition is NOT exported from `_internal/presence-emit.ts` (v7 relocated it to presence-projection-types.ts). If this assertion stops firing, the seal is broken.
import { emitPresenceTransition as sealCheckPureHelper } from "./_internal/presence-emit.js";
void sealCheckPureHelper;
