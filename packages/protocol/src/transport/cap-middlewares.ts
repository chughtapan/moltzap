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
import { principalGateErrorClasses } from "./wire-errors.js";
import type { RpcErrorClass } from "./method.js";
import {
  ConversationInTask,
  ConversationSendAccess,
  ActiveTaskPermission,
  OpenConversationPermission,
  ReplyTargetPermission,
  TaskReadAccess,
  ContactPolicyAllowsReach,
} from "../task/capabilities/index.js";

/** The `_tag`-discriminated failure union for a cap, from its `static errors`. */
const capFailure = (cap: {
  readonly errors: ReadonlyArray<RpcErrorClass>;
}): Schema.Schema.AnyNoContext =>
  Schema.Union(...(cap.errors as ReadonlyArray<RpcErrorClass>));

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

export class ActiveTaskPermissionMw extends RpcMiddleware.Tag<ActiveTaskPermissionMw>()(
  "@moltzap/protocol/cap/mw/active-task-permission",
  { provides: ActiveTaskPermission, failure: capFailure(ActiveTaskPermission) },
) {}

export class OpenConversationPermissionMw extends RpcMiddleware.Tag<OpenConversationPermissionMw>()(
  "@moltzap/protocol/cap/mw/open-conversation-permission",
  {
    provides: OpenConversationPermission,
    failure: capFailure(OpenConversationPermission),
  },
) {}

export class ReplyTargetPermissionMw extends RpcMiddleware.Tag<ReplyTargetPermissionMw>()(
  "@moltzap/protocol/cap/mw/reply-target-permission",
  {
    provides: ReplyTargetPermission,
    failure: capFailure(ReplyTargetPermission),
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
 * Cap `Context.Tag` key → its `RpcMiddleware.Tag`. The engine binding
 * (`server-engine-group.ts → buildEngineMember`) reads a method's `caps` tuple
 * and stacks each cap's middleware in declared order. A cap that a method can
 * require MUST appear here, or the binding leaves it ungated — the boot guard
 * (`assertCapMiddlewareCoverage`) fails the build if a declared cap has no
 * middleware.
 */
export const capMiddlewareByCapKey: Readonly<
  Record<string, RpcMiddleware.TagClassAny>
> = {
  [ConversationInTask.key]: ConversationInTaskMw,
  [ConversationSendAccess.key]: ConversationSendAccessMw,
  [ActiveTaskPermission.key]: ActiveTaskPermissionMw,
  [OpenConversationPermission.key]: OpenConversationPermissionMw,
  [ReplyTargetPermission.key]: ReplyTargetPermissionMw,
  [TaskReadAccess.key]: TaskReadAccessMw,
  [ContactPolicyAllowsReach.key]: ContactPolicyAllowsReachMw,
};

/**
 * Type-level cap `Context.Tag` → its `RpcMiddleware.Tag` (the runtime mirror is
 * {@link capMiddlewareByCapKey}). Matches by tag IDENTITY so the engine member's
 * middleware param carries the EXACT cap mws, keeping the per-cap `provides`
 * type-visible (a handler that `yield*`s a cap Tag has it stripped from the
 * Layer's residual requirement — the proof-exclusion guarantee).
 */
export type CapMwFor<Cap> = Cap extends typeof ConversationInTask
  ? ConversationInTaskMw
  : Cap extends typeof ConversationSendAccess
    ? ConversationSendAccessMw
    : Cap extends typeof ActiveTaskPermission
      ? ActiveTaskPermissionMw
      : Cap extends typeof OpenConversationPermission
        ? OpenConversationPermissionMw
        : Cap extends typeof ReplyTargetPermission
          ? ReplyTargetPermissionMw
          : Cap extends typeof TaskReadAccess
            ? TaskReadAccessMw
            : Cap extends typeof ContactPolicyAllowsReach
              ? ContactPolicyAllowsReachMw
              : never;

/**
 * The middleware stack an authenticated method's `caps` tuple maps to: the
 * `PrincipalGateMw` (every authenticated method) ∪ each declared cap's
 * middleware. The engine member's `Middleware` param is this union, so each
 * cap's `provides` is type-visible at the binding.
 */
export type MwStackFor<Caps extends ReadonlyArray<unknown>> =
  | PrincipalGateMw
  | CapMwFor<Caps[number]>;
