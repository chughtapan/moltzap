/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors message-send-permission.types-check.ts convention). */
/* eslint-disable agent-code-guard/no-manual-enum-cast -- canary asserts the literal-union shape of `DerivedPresenceStatus`; that IS the test. */

/**
 * Type-canary for the presence-projection contract (architect plan
 * #706 / sub-issue #711). Asserts the stub module exports the shape
 * impl-staff is committed to fill in:
 *
 * - `DerivedPresenceStatus` is the narrowed three-state union.
 * - `LeaseTransitionObserver` carries the two boundary methods
 *   (begin, end), each producing `Effect&lt;void, never, never>`.
 * - `PresenceProjection` extends `LeaseTransitionObserver` and adds
 *   the WS-lifecycle pair plus a `statusOf` read.
 * - `emitPresenceTransition` is a pure `(prev, next) => Option` of
 *   the narrowed status union.
 * - The factory returns `Effect&lt;PresenceProjection, never, never>`.
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */
import type { Effect, Option } from "effect";

import type {
  AgentPresenceEntry,
  DerivedPresenceStatus,
  LeaseTransitionObserver,
  PresenceEmission,
  PresenceProjection,
  PresenceProjectionDefect,
} from "./presence-projection.js";
import {
  emitPresenceTransition,
  makePresenceProjection,
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

declare const emitResult: ReturnType<typeof emitPresenceTransition>;
void (emitResult as Option.Option<DerivedPresenceStatus>);

declare const factoryResult: ReturnType<typeof makePresenceProjection>;
void (factoryResult as Effect.Effect<PresenceProjection, never, never>);

declare const defect: PresenceProjectionDefect;
void defect.agentId;
void defect.reason;

declare const emission: PresenceEmission;
void emission.agentId;
void emission.status;

declare const entry: AgentPresenceEntry;
void entry.activeLeases;
void entry.status;
