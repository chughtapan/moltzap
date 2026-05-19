/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors layer-boundary.types-check.ts convention). */

/**
 * Architect-plan #606 type-canary — the Decision A gate plus the
 * `defineTaskMethod` wrapper-boundary gate (Canary 5, added in r1 per
 * plan-eng-review-606 Finding 2).
 *
 * Five canaries:
 *
 *   1. Composite path: ONE `provideServiceEffect` drains the composite
 *      capability and leaves only the obtain helper's residual R.
 *   2. Union-of-tags + provide ONLY ONE side leaves the other in R
 *      (`@ts-expect-error` marker — load-bearing for Decision A).
 *   3. Union-of-tags + provide BOTH sides drains R (confirms the "AND"
 *      semantics; the composite replaces this with one provide).
 *   4. Standalone `ValidReplyTarget` / `NoReplyTarget` tags stay
 *      independently provideable (D1 may consume them separately).
 *   5. `defineTaskMethod` wrapper boundary catches a handler that
 *      yields a capability tag without piping `provideServiceEffect`
 *      (`@ts-expect-error` — load-bearing for plan §3 Decision A
 *      invariant that capability tags do NOT leak past the wrapper).
 *
 * Skeleton mirrors `packages/server/src/transport/layer-boundary.types-check.ts`
 * — same `@ts-expect-error` discipline; no test runner involvement; tsc
 * (and the layered-method type checker) is the canary.
 */
import { Effect } from "effect";
import { MessagesSend } from "@moltzap/protocol";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import type { CapabilityTags } from "../../transport/layer-tags.js";
import {
  MessageSendPermission,
  obtainMessageSendPermission,
} from "./message-send-permission.js";
import {
  NoReplyTarget,
  ValidReplyTarget,
  noReplyTarget,
  obtainValidReplyTarget,
} from "./reply-target.js";
import { TaskActive, refineTaskActive } from "./task-active.js";
import { TmAuthority, obtainTmAuthority } from "./tm-authority.js";

// Type-level reference to the sibling alias declared in layer-tags.ts
// (r1, Finding 1). Phase 1 impl-staff populates the union with
// concrete capability tags; for now CapabilityTags resolves to `never`
// — which is exactly what we want at the wrapper boundary.
declare const _capabilityTagsSentinel: CapabilityTags;
void _capabilityTagsSentinel;

// ─────────────────────────────────────────────────────────────────────
// CANARY 1 — composite capability compiles via provideServiceEffect
//
// The handler provides ONE capability via ONE `provideServiceEffect`
// call. The capability tag drains; the residual R is the obtain
// helper's own dependency union (TaskService | ConversationService |
// MessageService).
// ─────────────────────────────────────────────────────────────────────

declare const serviceBodyComposite: Effect.Effect<
  void,
  never,
  MessageSendPermission
>;
declare const obtainInput: Parameters<typeof obtainMessageSendPermission>[0];

const composite_OK: Effect.Effect<
  void,
  // E channel propagates the obtain helper's error union.
  Effect.Effect.Error<ReturnType<typeof obtainMessageSendPermission>>,
  // R drains to the obtain helper's own R (residual service Tags).
  Effect.Effect.Context<ReturnType<typeof obtainMessageSendPermission>>
> = serviceBodyComposite.pipe(
  Effect.provideServiceEffect(
    MessageSendPermission,
    obtainMessageSendPermission(obtainInput),
  ),
);
void composite_OK;

// ─────────────────────────────────────────────────────────────────────
// CANARY 2 — union-of-tags shape requires BOTH sides (the spec's gate)
//
// Body declares `R = TaskActive | TmAuthority`. The handler provides
// only ONE — `TmAuthority` via `provideServiceEffect`. The remaining
// `TaskActive` requirement stays in R; the resulting effect is NOT
// runnable until the other side is supplied (or the union is rewritten
// to optionalize via `Effect.serviceOption`, which loses compile-time
// enforcement).
//
// The `@ts-expect-error` below documents the canary's assertion: an
// "either/or" handler that provides only ONE side cannot satisfy
// `Effect.Effect<void, ..., never>`. If a future Effect release ever
// changes this, the `@ts-expect-error` flips and forces re-evaluation
// of Decision A.
// ─────────────────────────────────────────────────────────────────────

declare const serviceBodyUnion: Effect.Effect<
  void,
  never,
  TaskActive | TmAuthority
>;
declare const tmTaskId: Parameters<typeof obtainTmAuthority>[0];
declare const tmCaller: Parameters<typeof obtainTmAuthority>[1];

// @ts-expect-error - providing only `TmAuthority` leaves `TaskActive` in R;
// the result still requires `TaskActive`, so it cannot widen to `R = never`.
const union_MISSING_TASK_ACTIVE: Effect.Effect<void, never, never> =
  serviceBodyUnion.pipe(
    Effect.provideServiceEffect(
      TmAuthority,
      obtainTmAuthority(tmTaskId, tmCaller),
    ),
  );
void union_MISSING_TASK_ACTIVE;

// ─────────────────────────────────────────────────────────────────────
// CANARY 3 — providing BOTH sides drains R (also confirms why union
// is the wrong shape: "AND" is what the type system gives you, not
// "OR"). Composite-capability path replaces this with one provide.
// ─────────────────────────────────────────────────────────────────────

declare const activeStatus: Parameters<typeof refineTaskActive>[1];

const union_BOTH_provided: Effect.Effect<
  void,
  | Effect.Effect.Error<ReturnType<typeof obtainTmAuthority>>
  | Effect.Effect.Error<ReturnType<typeof refineTaskActive>>,
  Effect.Effect.Context<ReturnType<typeof obtainTmAuthority>>
> = serviceBodyUnion.pipe(
  Effect.provideServiceEffect(
    TmAuthority,
    obtainTmAuthority(tmTaskId, tmCaller),
  ),
  Effect.provideServiceEffect(
    TaskActive,
    refineTaskActive(tmTaskId, activeStatus),
  ),
);
void union_BOTH_provided;

// ─────────────────────────────────────────────────────────────────────
// CANARY 4 — reply-target tags stay independently provideable. D1 and
// future handlers may consume `ValidReplyTarget` / `NoReplyTarget` as
// standalone capabilities even though MessagesSend folds them into the
// composite.
//
// `Effect.provideService(NoReplyTarget, noReplyTarget())` carve-out:
// `noReplyTarget()` is a zero-payload synchronous constructor whose
// value type carries no Effect, so `provideService` (the non-Effect
// provider) is the correct primitive. `provideServiceEffect` would
// require a redundant `Effect.succeed(noReplyTarget())` wrapper with
// no behavioral gain. Every OTHER capability provider on the stub
// branch pipes `Effect.provideServiceEffect` (the Effect-valued
// obtain/refine helpers); this canary intentionally exercises both
// shapes together to document the convention.
// ─────────────────────────────────────────────────────────────────────

declare const serviceBodyReply: Effect.Effect<
  void,
  never,
  ValidReplyTarget | NoReplyTarget
>;
declare const replyConvId: Parameters<typeof obtainValidReplyTarget>[0];
declare const replyToId: Parameters<typeof obtainValidReplyTarget>[1];

const reply_BOTH_provided: Effect.Effect<
  void,
  Effect.Effect.Error<ReturnType<typeof obtainValidReplyTarget>>,
  Effect.Effect.Context<ReturnType<typeof obtainValidReplyTarget>>
> = serviceBodyReply.pipe(
  Effect.provideServiceEffect(
    ValidReplyTarget,
    obtainValidReplyTarget(replyConvId, replyToId),
  ),
  Effect.provideService(NoReplyTarget, noReplyTarget()),
);
void reply_BOTH_provided;

// ─────────────────────────────────────────────────────────────────────
// CANARY 5 — `defineTaskMethod` wrapper boundary rejects handlers that
// yield a capability tag without `provideServiceEffect`.
//
// Decision A's invariant (per plan #606 §3 Decision A): capability tags
// MUST drain inside the handler body before the Effect returns; they
// must not leak into the `defineTaskMethod` constraint. The wrapper's
// `Reqs extends TaskTags` upper bound (see
// `define-layered-method.ts → defineTaskMethod`) excludes the
// `CapabilityTags` sibling alias (declared in `layer-tags.ts` per
// r1; NOT folded into TaskTags), so a handler whose inferred `Reqs`
// includes `MessageSendPermission` fails the constraint.
//
// The `@ts-expect-error` below documents the canary's assertion: a
// handler that yields `MessageSendPermission` without piping
// `provideServiceEffect` is rejected at the wrapper call site. If the
// `@ts-expect-error` ever STOPS firing, the wrapper has been
// mis-widened (e.g., capability tags folded into TaskTags) and
// Decision A's compile-time promise has regressed.
// ─────────────────────────────────────────────────────────────────────

// Two structurally-identical handlers passed to the SAME wrapper. The
// ONLY difference between REJECTS and ACCEPTS is whether the body
// pipes `provideServiceEffect` to drain `MessageSendPermission`. If
// `@ts-expect-error` fires on REJECTS, the wrapper rejects undrained
// capability tags at the boundary — Decision A's compile-time promise
// holds. If it fails to fire, the wrapper has been mis-widened
// (capability tags folded into TaskTags) and the canary catches the
// regression.

const wrapper_BOUNDARY_REJECTS_UNDRAINED = defineTaskMethod(MessagesSend, {
  handler: (_params, _ctx) =>
    // @ts-expect-error - body yields MessageSendPermission and never
    // drains it; inferred Reqs includes the capability tag, which is
    // NOT in TaskTags (sibling CapabilityTags alias per layer-tags.ts
    // r1). The wrapper constraint Reqs extends TaskTags rejects.
    Effect.gen(function* () {
      const cap = yield* MessageSendPermission;
      return { message: cap as never };
    }),
});
void wrapper_BOUNDARY_REJECTS_UNDRAINED;

// Companion: the SAME handler shape with `provideServiceEffect` drains
// the capability and the wrapper accepts it. Load-bearing positive
// case — if this fails to compile, the drain pattern itself has
// regressed.
const wrapper_BOUNDARY_ACCEPTS_DRAINED = defineTaskMethod(MessagesSend, {
  handler: (_params, _ctx) =>
    Effect.gen(function* () {
      const cap = yield* MessageSendPermission;
      return { message: cap as never };
    }).pipe(
      Effect.provideServiceEffect(
        MessageSendPermission,
        obtainMessageSendPermission(obtainInput),
      ),
    ),
});
void wrapper_BOUNDARY_ACCEPTS_DRAINED;
