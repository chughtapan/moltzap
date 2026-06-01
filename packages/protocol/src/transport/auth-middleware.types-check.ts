/**
 * @file Type canaries for the per-method `AuthContext` proof tags +
 * `AuthMiddleware` descriptors (`transport/auth-middleware.ts`).
 *
 * These pin the §H proof shape that the server's per-method `AuthMiddleware`
 * runtime Layers and handlers depend on:
 *
 *   H.proj   the proof VALUE is PROJECTED from the descriptor — `principal` is
 *            the method-narrowed arm (`AgentContext` for `"agent"`, `AppContext`
 *            for `"app"`), and each declared cap contributes a proof field keyed
 *            by the cap tag's `key`, valued by the cap's service. A descriptor
 *            edit that flips the principal or adds a cap reshapes the proof.
 *   H.nv     the projection is NON-VACUOUS — a cap proof field is the cap's
 *            service value (not `any`/`unknown`), and a stray cap key is absent.
 *   H.mw     each descriptor's `provides` is its proof tag and it is non-optional
 *            (an optional middleware falls through to the handler on failure,
 *            letting a rejected principal/cap reach the body — a security hole).
 */
import type { CapProofs } from "./auth-context.js";
import {
  MessagesSendAuth,
  MessagesSendAuthMw,
  MessagesListAuth,
  TaskListAuth,
  TaskCloseAuth,
  TaskConversationArchiveAuth,
  type AuthProof,
} from "./auth-middleware.js";
import { ConversationInTask } from "../task/capabilities/conversation-in-task.js";
import { MessageSendPermission } from "../task/capabilities/message-send-permission.js";
import { TaskReadAccess } from "../task/capabilities/task-read-access.js";
import type { ConversationInTaskValue } from "../task/capabilities/conversation-in-task.js";
import type { MessageSendPermissionValue } from "../task/capabilities/message-send-permission.js";
import type { TaskReadAccessValue } from "../task/capabilities/task-read-access.js";
import type { MessagesSend } from "../task/messages.js";
import { Context } from "effect";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

// ── H.proj — proof value is projected from the descriptor ────────────────

// `messages/send` is `callablePrincipal: "agent"` → `principal` is the
// agent-narrowed arm (carries `agentId`, not `appId`).
type SendProof = Context.Tag.Service<typeof MessagesSendAuth>;
type _SendPrincipalAgent = Expect<
  Equal<SendProof["principal"]["_tag"], "AgentContext">
>;
// `task/close` is `callablePrincipal: "app"` → `principal` is the app arm.
type CloseProof = Context.Tag.Service<typeof TaskCloseAuth>;
type _ClosePrincipalApp = Expect<
  Equal<CloseProof["principal"]["_tag"], "AppContext">
>;

// `AuthProof<typeof MessagesSend>` equals the proof tag's service type — the tag
// reads the descriptor, never a parallel literal.
type _SendProofProjected = Expect<
  Equal<AuthProof<typeof MessagesSend>, SendProof>
>;

// ── H.nv — projection is non-vacuous ─────────────────────────────────────

// `messages/send` caps `[ConversationInTask, MessageSendPermission]` → each cap
// proof field is the cap's SERVICE value, read by the cap tag's `key`.
type _SendCit = Expect<
  Equal<SendProof[(typeof ConversationInTask)["key"]], ConversationInTaskValue>
>;
type _SendMsp = Expect<
  Equal<
    SendProof[(typeof MessageSendPermission)["key"]],
    MessageSendPermissionValue
  >
>;
// `messages/list` caps `[TaskReadAccess, ConversationInTask]`.
type ListProof = Context.Tag.Service<typeof MessagesListAuth>;
type _ListTra = Expect<
  Equal<ListProof[(typeof TaskReadAccess)["key"]], TaskReadAccessValue>
>;
// A cap-LESS method's proof has no cap keys beyond `principal`.
type TaskListProof = Context.Tag.Service<typeof TaskListAuth>;
type _TaskListNoCaps = Expect<Equal<keyof TaskListProof, "principal">>;
// A method WITHOUT a cap does not carry that cap's proof field (non-vacuous: the
// projection is not a permissive open record). `task/list` declares no caps, so
// the `ConversationInTask` key is absent.
type _NoStrayCap = Expect<
  (typeof ConversationInTask)["key"] extends keyof TaskListProof ? false : true
>;
// `task/conversation/archive` (app + `[ConversationInTask]`) carries exactly
// `principal` + the CIT key.
type ArchiveProof = Context.Tag.Service<typeof TaskConversationArchiveAuth>;
type _ArchiveKeys = Expect<
  Equal<keyof ArchiveProof, "principal" | (typeof ConversationInTask)["key"]>
>;

// `CapProofs<[]>` is the empty proof record (a cap-less method adds nothing).
type _EmptyCaps = Expect<Equal<keyof CapProofs<readonly []>, never>>;

// ── H.mw — descriptor provides the proof tag, non-optional ───────────────

type _SendMwProvides = Expect<
  Equal<(typeof MessagesSendAuthMw)["provides"], typeof MessagesSendAuth>
>;
type _SendMwNonOptional = Expect<
  Equal<(typeof MessagesSendAuthMw)["optional"], false>
>;

export type {
  _SendPrincipalAgent,
  _ClosePrincipalApp,
  _SendProofProjected,
  _SendCit,
  _SendMsp,
  _ListTra,
  _TaskListNoCaps,
  _NoStrayCap,
  _ArchiveKeys,
  _EmptyCaps,
  _SendMwProvides,
  _SendMwNonOptional,
};
