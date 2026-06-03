/**
 * @file Type canaries for the per-capability `@effect/rpc` middlewares
 * (`engine/cap-middlewares.ts`).
 *
 * Each capability is its own `RpcMiddleware.Tag`, stacked on a method via
 * chainable `Rpc.middleware(...)`. These pin the invariants the server's
 * per-cap middleware Layers and the engine binding depend on:
 *
 *   mw.provides   a cap middleware `provides` its capability `Context.Tag`, so
 *                 the handler reads that exact cap value off context.
 *   mw.gate       the principal gate has NO `provides` (a pure gate) and is
 *                 non-optional (an optional middleware falls through to the
 *                 handler on failure, letting a rejected principal reach the
 *                 body — a security hole).
 *   mw.failure    a cap middleware's `failure` is its capability's own error
 *                 union, so the engine unions it into the method's wire error.
 */
import { Schema } from "effect";
import {
  PrincipalGateMw,
  ConversationInTaskMw,
  ConversationSendAccessMw,
  type MiddlewareRequirementKey,
} from "./cap-middlewares.js";
import {
  ConversationInTask,
  ConversationSendAccess,
} from "../task/capabilities/index.js";
import { ConversationCreateAuthorization } from "../task/capabilities/conversation-create-authorization.js";
import type { CapabilityRequirement, Requirement } from "./requirements.js";
import type { ParamsOf } from "../transport/method.js";
import type { MessagesSend, MessagesList } from "../task/messages.js";
import type {
  TaskRequest,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
} from "../task/tasks.js";
import type { AgentId } from "../identity/agents.js";
import type { TaskId } from "../task/ids.js";
import type { ConversationId } from "../task/conversations.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;
type Extends<A, B> = [A] extends [B] ? true : false;

// ── requirement registry totality — the boot-guard replacement ────────────────
//
// The engine binding's `requirementMiddleware[cap.key]` lookup
// (`server-engine-group.ts → buildEngineMember`) is total with NO cast because
// every `CapabilityRequirement`'s `.key` is a `MiddlewareRequirementKey`. These
// canaries pin that correspondence at the type level, so a descriptor naming a
// cap requirement with no registered middleware fails to COMPILE — the guarantee
// the deleted boot-time gating walk (`findEngineGatingMismatch`) used to enforce
// at runtime.

// Every registered `CapabilityRequirement`'s key is a `MiddlewareRequirementKey`,
// so the total-map lookup is exhaustive without a cast.
type _CapKeysAreMwKeys = Expect<
  Extends<CapabilityRequirement["key"], MiddlewareRequirementKey>
>;
// A `CapabilityRequirement` is a `Requirement`, so it is admissible in `requires`.
type _CapIsRequirement = Expect<Extends<CapabilityRequirement, Requirement>>;
// A capability tag with NO registered middleware (`ConversationCreateAuthorization`
// has no `requirementMiddleware` entry) is NOT a `Requirement` — listing it in a
// descriptor's `requires` is a compile error at the `defineRpc` call.
type _UnregisteredCapNotRequirement = Expect<
  Extends<typeof ConversationCreateAuthorization, Requirement> extends true
    ? false
    : true
>;

// ── mw.provides — a cap middleware provides its capability Tag ────────────

type _CitProvides = Expect<
  Equal<(typeof ConversationInTaskMw)["provides"], typeof ConversationInTask>
>;
type _CsaProvides = Expect<
  Equal<
    (typeof ConversationSendAccessMw)["provides"],
    typeof ConversationSendAccess
  >
>;

// ── mw.gate — the principal gate provides nothing, non-optional ───────────

// A gate-only middleware carries no `provides` (`undefined`).
type _GateNoProvides = Expect<
  Equal<(typeof PrincipalGateMw)["provides"], undefined>
>;
// Every cap/gate middleware is non-optional (hard-fails the frame).
type _GateNonOptional = Expect<
  Equal<(typeof PrincipalGateMw)["optional"], false>
>;
type _CitNonOptional = Expect<
  Equal<(typeof ConversationInTaskMw)["optional"], false>
>;

// ── mw.failure — a cap middleware's failure is a real Schema (non-never) ──

// `ConversationSendAccess` declares `ForbiddenError`, so its middleware's
// `failure` is a concrete Schema (not the `Schema.Never` default), which the
// engine unions into `messages/send`'s wire error.
type _CsaFailureNotNever = Expect<
  Equal<
    (typeof ConversationSendAccessMw)["failure"] extends typeof Schema.Never
      ? true
      : false,
    false
  >
>;

// ── cap.params — every gating method's params carry the fields its cap derives ──
//
// The server cap-middleware impls (`auth-middleware-layers.ts`) derive each
// cap's obtain input from the decoded `payload`, which the engine types as
// `unknown` — so a derive reading a field the method does NOT declare (e.g. the
// real `task/request` bug where `ContactPolicyAllowsReach` read `targetAgentIds`
// instead of `invitedAgentIds`) compiles. These canaries close that gap: each
// gating method's `ParamsOf` MUST carry the fields its caps read, so a method or
// derive drift fails the build instead of defecting at runtime.

/** The params `ConversationInTask`'s derive reads. */
interface ConversationInTaskParams {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}
/** The params `ConversationSendAccess`'s derive reads. */
interface ConversationSendAccessParams {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}
/** The params `ContactPolicyAllowsReach`'s derive reads (the `task/request` cap). */
interface ContactPolicyAllowsReachParams {
  readonly invitedAgentIds: readonly AgentId[];
}

// `ConversationInTask` gates `messages/send`, `messages/list`, and the four
// `task/conversation/*` admin methods — each must carry `taskId`+`conversationId`.
type _CitSend = Expect<
  Extends<ParamsOf<typeof MessagesSend>, ConversationInTaskParams>
>;
type _CitList = Expect<
  Extends<ParamsOf<typeof MessagesList>, ConversationInTaskParams>
>;
type _CitArchive = Expect<
  Extends<ParamsOf<typeof TaskConversationArchive>, ConversationInTaskParams>
>;
type _CitUnarchive = Expect<
  Extends<ParamsOf<typeof TaskConversationUnarchive>, ConversationInTaskParams>
>;
type _CitAddPart = Expect<
  Extends<
    ParamsOf<typeof TaskConversationAddParticipant>,
    ConversationInTaskParams
  >
>;
type _CitRemovePart = Expect<
  Extends<
    ParamsOf<typeof TaskConversationRemoveParticipant>,
    ConversationInTaskParams
  >
>;
// `ConversationSendAccess` gates `messages/send`.
type _CsaSend = Expect<
  Extends<ParamsOf<typeof MessagesSend>, ConversationSendAccessParams>
>;
// `ContactPolicyAllowsReach` gates `task/request` — must carry `invitedAgentIds`.
type _CparReach = Expect<
  Extends<ParamsOf<typeof TaskRequest>, ContactPolicyAllowsReachParams>
>;

export type {
  _CapKeysAreMwKeys,
  _CapIsRequirement,
  _UnregisteredCapNotRequirement,
  _CitProvides,
  _CsaProvides,
  _GateNoProvides,
  _GateNonOptional,
  _CitNonOptional,
  _CsaFailureNotNever,
  _CitSend,
  _CitList,
  _CitArchive,
  _CitUnarchive,
  _CitAddPart,
  _CitRemovePart,
  _CsaSend,
  _CparReach,
};
