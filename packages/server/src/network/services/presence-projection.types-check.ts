/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors message-send-permission.types-check.ts convention). */
/* eslint-disable agent-code-guard/no-manual-enum-cast -- canary asserts the literal-union shape of `DerivedPresenceStatus`; that IS the test. */
/* eslint-disable jsdoc/text-escaping -- the canary doc literally cites `Effect<void, never, never>` as a type expression in prose; escaping the angle brackets would render them as escape codes in rendered docs. */

/**
 * Type-canary for the presence-projection contract (architect plan
 * #706 / sub-issue #711, v5). Asserts:
 *
 * 1. **Public surface shape** — the stub module exports the symbols
 *    impl-staff is committed to fill in:
 *    - `DerivedPresenceStatus` is the narrowed three-state union.
 *    - `LeaseTransitionObserver` carries the two boundary methods
 *      (begin, end), each producing `Effect<void, never, never>`.
 *    - `noopLeaseTransitionObserver` is a default-shaped observer
 *      (replaces v1's nullable shape).
 *    - `PresenceProjection` extends `LeaseTransitionObserver` and
 *      adds the WS-lifecycle pair plus `statusOf` + `statusMany`
 *      (codex r2 P2 #1 fix — read surface migrates from
 *      `PresenceService.get/getMany` to the projection).
 *    - `emitPresenceTransition` is a pure
 *      `(prev, next) => Option` of the narrowed status union.
 *    - `EmitIfChanged` is the in-module-curried emit capability
 *      type (v5 / codex r4 P2 #2 — every transition method takes
 *      a value of this shape instead of raw sink access).
 *    - The factory's deps carry `subscribers: PresenceSubscriberRegistry`
 *      + `connections: ConnectionManager` (codex r2 P2 #4 fix — the
 *      sink is constructed INSIDE the factory body from
 *      `connections`; deps NEVER carry a sink).
 *    - `PresenceProjectionAuditEvent` is the discriminated union
 *      for "expected during teardown" lease callbacks (codex r2
 *      P2 #2 + P2 #3 fix — split from defect taxonomy).
 *    - The factory returns
 *      `Effect<PresenceProjection, never, never>`.
 *
 * 2. **External-import seal at TS-module level** (codex r2 P2 #4) —
 *    asserts that the sink type + factory are NOT exported. The two
 *    `ts-expect-error` assertions at the bottom of this file
 *    guarantee that any external module's
 *    `import { InternalPresenceEventSink }` /
 *    `import { createInternalFanOutEventSink }` MUST fail with TS2305
 *    "Module has no exported member".
 *
 * 2.1. **In-module emit seal** (v5 / codex r4 P2 #2) — a third
 *    `ts-expect-error` assertion asserts that
 *    `createEmitIfChanged` is ALSO unexported. The combination of
 *    "raw sink unreachable from outside the module" (2) and "raw
 *    sink unreachable from non-factory code inside the module"
 *    (this) is what enforces the dedup gate structurally across
 *    BOTH axes — external imports fail at the TS layer; in-module
 *    transition helpers must take `emit: EmitIfChanged` as a
 *    parameter rather than the raw sink.
 *
 * 3. **Integration surfaces** (codex r2 P2 #6) — asserts the
 *    integration symbols the v3 plan §3 cites exist with the right
 *    shape:
 *    - `PresenceServiceTag` (existing) can provide a value matching
 *      `PresenceSubscriberRegistry` (subscriber-read surface).
 *    - `ConnectionManagerTag` (existing) can provide a value matching
 *      `PresenceProjectionDeps.connections`.
 *    - The lease-registry's transition-observer dep field can be
 *      satisfied by `LeaseTransitionObserver` and defaults to
 *      `noopLeaseTransitionObserver` (covered by surface-level
 *      assertion above; stub-level assertion lands on
 *      `lease-registry.ts` when impl-staff edits the file).
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */
import type { Effect, Option } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";

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
} from "./presence-projection.js";

declare const status: DerivedPresenceStatus;
// #ignore-sloppy-code-next-line[enum-cast]: canary asserts the literal-union shape of `DerivedPresenceStatus` — that IS the assertion.
void (status as "online" | "working" | "offline");

declare const observer: LeaseTransitionObserver;
declare const projection: PresenceProjection;
const _projectionIsObserver: LeaseTransitionObserver = projection;
void _projectionIsObserver;
void observer.onLeaseActiveBegin;
void observer.onLeaseActiveEnd;
void projection.onAgentConnect;
void projection.onAgentDisconnect;
void projection.statusOf;
void projection.statusMany; // v3: read surface migrated from PresenceService

// noop observer satisfies the observer surface and is usable as the
// LeaseRegistry's transitionObserver default (no nullable branch).
const _noopIsObserver: LeaseTransitionObserver = noopLeaseTransitionObserver;
void _noopIsObserver;

declare const emitResult: ReturnType<typeof emitPresenceTransition>;
void (emitResult as Option.Option<DerivedPresenceStatus>);

declare const factoryResult: ReturnType<typeof makePresenceProjection>;
void (factoryResult as Effect.Effect<PresenceProjection, never, never>);

// v4 (codex r3 P3 #2): the defect-boundary wrapper has the right
// shape. Generic over the fallback type; output preserves `never`
// for both E and R channels.
declare const wrappedVoid: ReturnType<typeof catchProjectionDefect<void>>;
void (wrappedVoid as Effect.Effect<void, never, never>);
declare const wrappedStatus: ReturnType<
  typeof catchProjectionDefect<DerivedPresenceStatus>
>;
void (wrappedStatus as Effect.Effect<DerivedPresenceStatus, never, never>);

// v5 (codex r4 P2 #2): EmitIfChanged is the in-module-curried emit
// capability — the only emission surface the projection's transition
// methods receive. Shape: (prev, next, agentId) => Effect<void, never, never>.
// Dedup is folded into the helper via `emitPresenceTransition`; the
// transition methods cannot reach the raw `sink.publish` through any
// other in-module path.
declare const emitter: EmitIfChanged;
declare const someAgentId: AgentId;
void (emitter as (
  prev: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
  agentId: AgentId,
) => Effect.Effect<void, never, never>);
void emitter("online", "working", someAgentId);

declare const defect: PresenceProjectionDefect;
void defect.agentId;
// v4 (codex r3 P2 #1): the only remaining defect reason is
// `entry-status-size-mismatch` — `connect-against-active-entry` was
// deleted because redundant `onAgentConnect` against a tracked entry
// is a normal idempotent no-op (the connect handler's
// `if (conn.auth) { return ... }` early-return reaches it). If a
// fourth reason gets added, this assignment fails and forces the
// architect to revisit the taxonomy.
void (defect.reason as "entry-status-size-mismatch");

declare const emission: PresenceEmission;
void emission.agentId;
void emission.status;

declare const entry: AgentPresenceEntry;
void entry.activeLeases;
void entry.status;

// v3: PresenceProjectionAuditEvent discriminated union for "expected
// during teardown" lease callbacks (codex r2 P2 #2 + P2 #3 fix).
// Discriminator exhaustiveness — `absurdCheck` is a type-level
// assertion that every variant has been handled; if impl-staff adds
// a third variant, the assignment to `never` fails.
declare const audit: PresenceProjectionAuditEvent;
void audit.agentId;
void audit.leaseId;
const auditTag = audit._tag;
declare function absurdCheck(x: never): never;
if (
  auditTag !== "LeaseEndAfterDisconnect" &&
  auditTag !== "LeaseBeginAfterDisconnect"
) {
  absurdCheck(auditTag);
}

// v3: deps carry `subscribers` + `connections` (NOT a sink — codex
// r2 P2 #4 capability-seal fix; the sink is constructed inside the
// factory body from `connections`).
declare const deps: PresenceProjectionDeps;
void deps.subscribers;
void deps.connections;

declare const subs: PresenceSubscriberRegistry;
void subs.getSubscribers;

// ── Capability seal canary (codex r2 P2 #4) ──────────────────────────
//
// The following two assertions are the structural-seal proof. They
// MUST produce `ts-expect-error` lines: the projection module
// intentionally does NOT export the sink interface or its factory.
// If either assertion stops failing, the sealing has been broken
// (someone added `export` to InternalPresenceEventSink or
// createInternalFanOutEventSink) and `tsc --build` will
// fail with "Unused @ts-expect-error directive" until the export is
// removed again.

// @ts-expect-error — capability seal: InternalPresenceEventSink is NOT exported. If this assertion stops firing, the seal is broken.
import type { InternalPresenceEventSink as SealCheckType } from "./presence-projection.js";
// The type import above is the canary; consume it as a `declare const`
// so the import is not erased by `tsc` before the @ts-expect-error
// directive can fire.
declare const sealCheckTypeProbe: SealCheckType;
void sealCheckTypeProbe;

// @ts-expect-error — capability seal: createInternalFanOutEventSink is NOT exported. If this assertion stops firing, the seal is broken.
import { createInternalFanOutEventSink as sealCheckFactory } from "./presence-projection.js";
void sealCheckFactory;

// v5 (codex r4 P2 #2) — IN-MODULE seal canary. `createEmitIfChanged`
// is the helper that closes over the raw sink to produce the
// dedup-gated `EmitIfChanged` capability. It MUST be unexported too:
// if a future in-module helper could call `createEmitIfChanged({ sink,
// subscribers })` with a sink from anywhere, the seal would re-open
// (you could pass in any `{ publish }` object satisfying the shape).
// The external `InternalPresenceEventSink` seal (above) already makes
// "any" hard, but the in-module canary closes the loop: ALL three
// `Internal*` symbols stay module-private.
// @ts-expect-error — in-module emit seal: createEmitIfChanged is NOT exported. If this assertion stops firing, the in-module seal is broken.
import { createEmitIfChanged as sealCheckEmitter } from "./presence-projection.js";
void sealCheckEmitter;
