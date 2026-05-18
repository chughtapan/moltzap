/**
 * Architect-plan #606 type-canary — the Decision A gate.
 *
 * Phase 1 implement-staff fills the bodies and confirms the canary
 * compiles with the assertions documented below; if `provideServiceEffect`
 * lets the union-of-tags shape compose cleanly, the composite path
 * stays but `@ts-expect-error` markers below either disappear or move
 * (the body comments document each markers' role).
 *
 * Skeleton mirrors `packages/server/src/transport/layer-boundary.types-check.ts`
 * — same `@ts-expect-error` discipline; no test runner involvement; tsc
 * (and the layered-method type checker) is the canary.
 */
import { Context, Effect } from "effect";
import {
  MessageSendPermission,
  obtainMessageSendPermission,
} from "./message-send-permission.js";
import {
  NoReplyTarget,
  ValidReplyTarget,
  noReplyTarget,
} from "./reply-target.js";
import { TaskActive } from "./task-active.js";
import { TmAuthority } from "./tm-authority.js";

// ─────────────────────────────────────────────────────────────────────
// CANARY 1 — composite capability compiles via provideServiceEffect
//
// The handler provides ONE capability via ONE `provideServiceEffect`
// call. Service body's R channel is drained — `Effect<R = never>`.
// ─────────────────────────────────────────────────────────────────────

declare const serviceBodyComposite: Effect.Effect<
  void,
  never,
  MessageSendPermission
>;
declare const obtainInput: Parameters<typeof obtainMessageSendPermission>[0];

const composite_OK: Effect.Effect<
  void,
  never,
  // R drains to the obtain helper's own R (TaskService | ConversationService | MessageService)
  Context.Tag.Identifier<ReturnType<typeof obtainMessageSendPermission>>
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
// only ONE — `TmAuthority`. The remaining `TaskActive` requirement
// stays in R; the resulting effect is NOT runnable until the other side
// is supplied (or the union is rewritten to optionalize via
// `Effect.serviceOption`, which loses the compile-time enforcement).
//
// The `@ts-expect-error` below documents the canary's assertion: an
// "either/or" handler that provides only ONE side cannot satisfy
// `Effect.Effect<void, never, never>`. If a future Effect release ever
// changes this, the `@ts-expect-error` flips and forces re-evaluation
// of Decision A.
// ─────────────────────────────────────────────────────────────────────

declare const serviceBodyUnion: Effect.Effect<
  void,
  never,
  TaskActive | TmAuthority
>;
declare const tmCap: Context.Tag.Service<TmAuthority>;

// @ts-expect-error - providing only `TmAuthority` leaves `TaskActive` in R;
// the result still requires `TaskActive`, so it cannot widen to `R = never`.
const union_MISSING_TASK_ACTIVE: Effect.Effect<void, never, never> =
  serviceBodyUnion.pipe(Effect.provideService(TmAuthority, tmCap));
void union_MISSING_TASK_ACTIVE;

// ─────────────────────────────────────────────────────────────────────
// CANARY 3 — providing BOTH sides drains R (also confirms why union
// is the wrong shape: "AND" is what the type system gives you, not
// "OR"). Composite-capability path replaces this with one provide.
// ─────────────────────────────────────────────────────────────────────

declare const taskActiveCap: Context.Tag.Service<TaskActive>;
const union_BOTH_provided: Effect.Effect<void, never, never> =
  serviceBodyUnion.pipe(
    Effect.provideService(TmAuthority, tmCap),
    Effect.provideService(TaskActive, taskActiveCap),
  );
void union_BOTH_provided;

// ─────────────────────────────────────────────────────────────────────
// CANARY 4 — reply-target tags stay independently provideable. D1 and
// future handlers may consume `ValidReplyTarget` / `NoReplyTarget` as
// standalone capabilities even though MessagesSend folds them into the
// composite.
// ─────────────────────────────────────────────────────────────────────

declare const serviceBodyReply: Effect.Effect<
  void,
  never,
  ValidReplyTarget | NoReplyTarget
>;
declare const validReplyCap: Context.Tag.Service<ValidReplyTarget>;

const reply_BOTH_provided: Effect.Effect<void, never, never> =
  serviceBodyReply.pipe(
    Effect.provideService(ValidReplyTarget, validReplyCap),
    Effect.provideService(NoReplyTarget, noReplyTarget()),
  );
void reply_BOTH_provided;
