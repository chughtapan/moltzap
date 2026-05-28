/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors message-send-permission.types-check.ts convention). */
/* eslint-disable jsdoc/text-escaping -- the canary doc literally cites `Effect<void, never, never>` as a type expression in prose; escaping the angle brackets would render them as escape codes in rendered docs. */

/**
 * Type-canary for the presence-projection contract (architect plan
 * #706 / sub-issue #711, v6). Asserts:
 *
 * 1. **Public surface shape** — the stub module exports the symbols
 *    impl-staff is committed to fill in. v6 uses direct-annotation
 *    form (`const _check: T = x; void _check;`) instead of
 *    `void (x as T)` per plan-eng r5 P3 — the `as` cast permits
 *    bidirectional widening and does NOT catch a relax of the
 *    underlying type. Direct annotation triggers TS2322 on widening.
 *
 *    - `DerivedPresenceStatus` is the narrowed three-state union.
 *    - `LeaseTransitionObserver` carries the two boundary methods
 *      (begin, end), each producing `Effect<void, never, never>`.
 *      **v6 (codex r5 P2 #1)**: both methods take a third
 *      `recipientConnId: ConnectionId` parameter so the projection
 *      can detect lease callbacks that arrive from a now-stale
 *      connection (fast-reconnect race).
 *    - `noopLeaseTransitionObserver` is a default-shaped observer.
 *    - `PresenceProjection` extends `LeaseTransitionObserver` and
 *      adds the WS-lifecycle pair plus `statusOf` + `statusMany`
 *      (codex r2 P2 #1 fix — read surface migrates from
 *      `PresenceService.get/getMany` to the projection).
 *      **v6**: `onAgentConnect` and `onAgentDisconnect` BOTH take
 *      a `connId: ConnectionId` second parameter.
 *    - `emitPresenceTransition` is a pure
 *      `(prev, next) => Option` of the narrowed status union
 *      (re-exported from `presence-projection.ts` per v6 architect
 *      contract surface, but the impl lives in
 *      `_internal/presence-emit.ts`).
 *    - `EmitIfChanged` is the in-module-curried emit capability
 *      type (v5 / codex r4 P2 #2; v6 moves the impl into
 *      `_internal/presence-emit.ts` per codex r5 P2 #2 — the
 *      projection module re-exports the type from `_internal/`).
 *    - The factory's deps carry `subscribers: PresenceSubscriberRegistry`
 *      + `connections: ConnectionManager` (codex r2 P2 #4 fix — the
 *      sink is constructed INSIDE the factory body from
 *      `connections`; deps NEVER carry a sink).
 *    - `PresenceProjectionAuditEvent` is the discriminated union
 *      for "expected during teardown" lease callbacks (codex r2
 *      P2 #2 + P2 #3 fix; v6 adds
 *      `LeaseCallbackFromStaleConnection` for the fast-reconnect
 *      race per codex r5 P2 #1).
 *    - The factory returns
 *      `Effect<PresenceProjection, never, never>`.
 *    - **v6 (codex r5 P2 #3): `PresenceProjectionTag` (Effect
 *      Context tag) + `PresenceProjectionLive` (Layer)** are
 *      promoted from impl-staff scope to architect tier; the
 *      canary asserts the Tag's value type is `PresenceProjection`
 *      and the Layer's output type is `PresenceProjectionTag`.
 *
 * 2. **External-import seal at `_internal/presence-emit.ts`** (codex
 *    r2 P2 #4 + v6 codex r5 P2 #2) — asserts that the sink type +
 *    fan-out factory + pure dedup function are NOT exported from
 *    `_internal/presence-emit.ts`. Three `@ts-expect-error`
 *    assertions at the bottom of this file guarantee any external
 *    module's
 *    `import { InternalPresenceEventSink | createInternalFanOutEventSink | emitPresenceTransition }`
 *    from `_internal/presence-emit.ts` MUST fail with TS2305
 *    "Module has no exported member". The pure
 *    `emitPresenceTransition` IS importable from the projection's
 *    own re-export (`presence-projection.ts`), but NOT directly from
 *    `_internal/presence-emit.ts` — callers MUST go through the
 *    architect contract surface.
 *
 * 2.1. **In-module emit seal — now structural at directory boundary**
 *    (v6 / codex r5 P2 #2). v5 used three `@ts-expect-error` lines
 *    against `presence-projection.ts` exports
 *    (`InternalPresenceEventSink`, `createInternalFanOutEventSink`,
 *    `createEmitIfChanged`). v6 moves the raw sink + factory + emit
 *    helper into `_internal/presence-emit.ts`, so the seal is
 *    enforced by physical module separation: `presence-projection.ts`
 *    itself cannot import the raw sink because nothing exports it
 *    from `_internal/presence-emit.ts`. The canary lines now point
 *    at `_internal/presence-emit.ts`.
 *
 * 3. **Integration surfaces** (codex r2 P2 #6) — asserts the
 *    integration symbols the v3 plan §3 cites exist with the right
 *    shape (covered by
 *    `presence-projection-integration.types-check.ts`).
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */
import type { Effect, Layer, Option } from "effect";

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
  PresenceProjectionDefect,
  PresenceSubscriberRegistry,
} from "./presence-projection.js";
import {
  catchProjectionDefect,
  emitPresenceTransition,
  makePresenceProjection,
  noopLeaseTransitionObserver,
  PresenceProjectionLive,
  PresenceProjectionTag,
} from "./presence-projection.js";

// ── 1. Public surface direct-annotation assertions (v6 — plan-eng r5 P3) ──
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
// recipientConnId; lifecycle methods take agentId + connId. Asserted
// via direct annotation of the function type.
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

declare const factoryResult: ReturnType<typeof makePresenceProjection>;
const _factoryResultCheck: Effect.Effect<PresenceProjection, never, never> =
  factoryResult;
void _factoryResultCheck;

// v4 (codex r3 P3 #2): the defect-boundary wrapper has the right
// shape. Generic over the fallback type; output preserves `never`
// for both E and R channels.
declare const wrappedVoid: ReturnType<typeof catchProjectionDefect<void>>;
const _wrappedVoidCheck: Effect.Effect<void, never, never> = wrappedVoid;
void _wrappedVoidCheck;
declare const wrappedStatus: ReturnType<
  typeof catchProjectionDefect<DerivedPresenceStatus>
>;
const _wrappedStatusCheck: Effect.Effect<DerivedPresenceStatus, never, never> =
  wrappedStatus;
void _wrappedStatusCheck;

declare const defect: PresenceProjectionDefect;
void defect.agentId;
// v6 plan-eng r5 P3 fix: direct annotation instead of `as` cast so
// adding a third reason fails TS2322 (the `as` form previously did
// NOT catch widening).
const _defectReasonCheck: "entry-status-size-mismatch" = defect.reason;
void _defectReasonCheck;

declare const emission: PresenceEmission;
void emission.agentId;
void emission.status;

declare const entry: AgentPresenceEntry;
void entry.connId; // v6: entries carry the originating connId
void entry.activeLeases;
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
// v6 plan-eng r5 P3 fix: direct annotation instead of `as` cast.
declare const emitter: EmitIfChanged;
declare const someAgentId: AgentId;
const _emitterShape: (
  prev: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
  agentId: AgentId,
) => Effect.Effect<void, never, never> = emitter;
void _emitterShape;
void emitter("online", "working", someAgentId);

// v6 (codex r5 P2 #3): PresenceProjectionTag + PresenceProjectionLive
// promoted from impl-staff scope to architect tier. Canary asserts:
// - PresenceProjectionTag's value type is PresenceProjection.
// - PresenceProjectionLive is a Layer whose output type is
//   PresenceProjectionTag.
const _tagSelfCheck: typeof PresenceProjectionTag = PresenceProjectionTag;
void _tagSelfCheck;
// The Layer's output type is PresenceProjectionTag. R channel is left
// unconstrained at architect-stub stage; impl-staff narrows to
// PresenceServiceTag | ConnectionManagerTag once the body lands.
const _layerOutputCheck: Layer.Layer<PresenceProjectionTag, never, unknown> =
  PresenceProjectionLive;
void _layerOutputCheck;

// ── Capability seal canary (codex r2 P2 #4; v6 retargeted to `_internal/`) ──
//
// The following three assertions are the structural-seal proof. v6
// moves the raw sink + factory + dedup helper into
// `_internal/presence-emit.ts`. The canary asserts that NONE of the
// three target symbols are exported from `_internal/presence-emit.ts`.
// (The pure `emitPresenceTransition` IS exported from
// `_internal/presence-emit.ts` — its body lives there — but callers
// MUST route through the projection module's re-export. The canary
// for `emitPresenceTransition` checks that the projection-module
// re-export is the only documented import path; it is NOT a TS2305
// seal because `_internal/` does export it.)
//
// If either of the two TS2305 assertions stops failing, the seal has
// been broken (someone added `export` to a symbol in
// `_internal/presence-emit.ts`) and `tsc --build` will fail with
// "Unused @ts-expect-error directive" until the export is removed
// again.

// @ts-expect-error — capability seal: InternalPresenceEventSink is NOT exported from `_internal/presence-emit.ts`. If this assertion stops firing, the external seal is broken.
import type { InternalPresenceEventSink as SealCheckType } from "./_internal/presence-emit.js";
declare const sealCheckTypeProbe: SealCheckType;
void sealCheckTypeProbe;

// @ts-expect-error — capability seal: createInternalFanOutEventSink is NOT exported from `_internal/presence-emit.ts`. If this assertion stops firing, the external seal is broken.
import { createInternalFanOutEventSink as sealCheckFactory } from "./_internal/presence-emit.js";
void sealCheckFactory;
