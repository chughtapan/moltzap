/**
 * @file Per-capability `@effect/rpc` middlewares.
 *
 * Each capability is its OWN `RpcMiddleware.Tag`, stacked on a method via
 * chainable `Rpc.middleware(...)`. A cap middleware `provides` its capability
 * `Context.Tag` (the proof the handler reads) and carries its own `failure`
 * schema — the `_tag`-discriminated union of the errors the cap can raise. The
 * engine unions each stacked middleware's `failure` into the method's wire error
 * (`Rpc.ErrorSchema = _Error | _Middleware`), so a method's error channel is
 * assembled FROM its middleware stack, not aggregated by the method.
 *
 * The principal gate is the one middleware with no `provides` — a pure gate that
 * narrows the live connection to the method's principal arm and fails
 * `Unauthorized` / `Forbidden`. The handler reads the narrowed principal off
 * `ConnectionTag` (`agentArm` / `appArm`), so the gate provides nothing; it only
 * rejects the wrong arm.
 *
 * The server supplies each middleware's impl as a per-socket `Layer` over the
 * Tag declared here (one-way protocol→server edge: the protocol declares WHICH
 * proof each cap provides + WHICH errors it raises; the server provides the
 * runtime that resolves it).
 */
import { Schema } from "effect";
import { RpcMiddleware } from "@effect/rpc";
import { principalGateErrorClasses } from "../transport/wire-errors.js";
import type { RpcErrorClass } from "../transport/method.js";
import { AgentPrincipal, AppPrincipal } from "../transport/principal.js";
import {
  ConversationInTask,
  ConversationSendAccess,
  TaskReadAccess,
  ContactPolicyAllowsReach,
} from "../task/capabilities/index.js";

/** The `_tag`-discriminated failure union for a cap, from its `static errors`. */
const capFailure = (cap: {
  readonly errors: ReadonlyArray<RpcErrorClass>;
}): Schema.Schema.AnyNoContext => Schema.Union(...cap.errors);

/** Principal-gate failure: every authenticated method admits these. */
const principalGateFailure: Schema.Schema.AnyNoContext = Schema.Union(
  ...principalGateErrorClasses,
);

/**
 * The principal gate: narrows the live connection to the method's principal arm
 * and fails `Unauthorized` / `Forbidden`. No `provides` — the handler reads the
 * narrowed arm off `ConnectionTag`. Stacked first on every authenticated method.
 */
export class PrincipalGateMw extends RpcMiddleware.Tag<PrincipalGateMw>()(
  "@moltzap/protocol/cap/mw/principal-gate",
  { failure: principalGateFailure },
) {}

export class ConversationInTaskMw extends RpcMiddleware.Tag<ConversationInTaskMw>()(
  "@moltzap/protocol/cap/mw/conversation-in-task",
  { provides: ConversationInTask, failure: capFailure(ConversationInTask) },
) {}

export class ConversationSendAccessMw extends RpcMiddleware.Tag<ConversationSendAccessMw>()(
  "@moltzap/protocol/cap/mw/conversation-send-access",
  {
    provides: ConversationSendAccess,
    failure: capFailure(ConversationSendAccess),
  },
) {}

export class TaskReadAccessMw extends RpcMiddleware.Tag<TaskReadAccessMw>()(
  "@moltzap/protocol/cap/mw/task-read-access",
  { provides: TaskReadAccess, failure: capFailure(TaskReadAccess) },
) {}

export class ContactPolicyAllowsReachMw extends RpcMiddleware.Tag<ContactPolicyAllowsReachMw>()(
  "@moltzap/protocol/cap/mw/contact-policy-allows-reach",
  {
    provides: ContactPolicyAllowsReach,
    failure: capFailure(ContactPolicyAllowsReach),
  },
) {}

/**
 * Every requirement key that carries a middleware: both principal requirements
 * plus each capability tag. The `AgentClaimed` refinement is EXCLUDED — it
 * carries no middleware (an active-arm check the principal gate's per-method
 * impl Layer reads off `requires`). This union makes {@link requirementMiddleware}
 * a TOTAL map: a requirement key added without a middleware entry fails the
 * `satisfies` below, so the engine binding can never leave a requirement ungated.
 */
export type MiddlewareRequirementKey =
  | typeof AgentPrincipal.key
  | typeof AppPrincipal.key
  | typeof ConversationInTask.key
  | typeof ConversationSendAccess.key
  | typeof TaskReadAccess.key
  | typeof ContactPolicyAllowsReach.key;

/**
 * Requirement key → its `RpcMiddleware.Tag`. The engine binding
 * (`server-engine-group.ts → buildEngineMember`) reads a method's `requires`
 * list and stacks each requirement's middleware in declared order. Both
 * principal requirements (`AgentPrincipal` / `AppPrincipal`) map to the single
 * {@link PrincipalGateMw}; each capability maps to its own cap middleware. The
 * map is TOTAL over {@link MiddlewareRequirementKey} (enforced by `satisfies`),
 * so the lookup never returns `undefined` and the descriptor↔binding
 * correspondence is compile-checked — no boot-time gating walk needed.
 */
export const requirementMiddleware = {
  [AgentPrincipal.key]: PrincipalGateMw,
  [AppPrincipal.key]: PrincipalGateMw,
  [ConversationInTask.key]: ConversationInTaskMw,
  [ConversationSendAccess.key]: ConversationSendAccessMw,
  [TaskReadAccess.key]: TaskReadAccessMw,
  [ContactPolicyAllowsReach.key]: ContactPolicyAllowsReachMw,
} satisfies Record<MiddlewareRequirementKey, RpcMiddleware.TagClassAny>;

/**
 * Type-level requirement `Context.Tag` → its `RpcMiddleware.Tag` (the runtime
 * mirror is {@link requirementMiddlewareByKey}). Matches by tag IDENTITY so the
 * engine member's middleware param carries the EXACT mws, keeping each cap's
 * `provides` type-visible (a handler that `yield*`s a cap Tag has it stripped
 * from the Layer's residual requirement — the proof-exclusion guarantee). Both
 * principal requirements map to `PrincipalGateMw`; the `AgentClaimed` refinement
 * carries no middleware (maps to `never`).
 */
export type MwForRequirement<Req> = Req extends typeof AgentPrincipal
  ? typeof PrincipalGateMw
  : Req extends typeof AppPrincipal
    ? typeof PrincipalGateMw
    : Req extends typeof ConversationInTask
      ? typeof ConversationInTaskMw
      : Req extends typeof ConversationSendAccess
        ? typeof ConversationSendAccessMw
        : Req extends typeof TaskReadAccess
          ? typeof TaskReadAccessMw
          : Req extends typeof ContactPolicyAllowsReach
            ? typeof ContactPolicyAllowsReachMw
            : never;

/**
 * The middleware stack a method's `requires` list maps to: each requirement's
 * `RpcMiddleware.Tag` (principal → `PrincipalGateMw`, cap → its cap mw,
 * `AgentClaimed` → `never`). The engine member's `Middleware` param is this
 * union, so each cap's `provides` is type-visible at the binding. The empty
 * `requires` (`network/connect`) maps to `never` — no middleware.
 */
export type MwStackFor<Requires extends ReadonlyArray<unknown>> =
  MwForRequirement<Requires[number]>;
