/**
 * @file The per-method `AuthMiddleware` descriptors + their `AuthContext` proof
 * tags — ONE unified native `@effect/rpc` middleware per authenticated method
 * (principal-kind gate + caps inside it).
 *
 * Each authenticated method carries ONE {@link RpcMiddleware.Tag} whose
 * `provides` is that method's `AuthContext` proof tag. The middleware impl
 * (server-supplied per-socket `Layer`) resolves the principal, runs the
 * method's declared caps WITH the principal in scope, and provides the combined
 * {@link AuthContextValue} proof: `{ principal }` plus one field per declared
 * cap. The handler reads `yield*` its method's proof tag and pulls the narrowed
 * principal + each cap proof off it.
 *
 * The descriptor is protocol-owned because the proof Tag it provides is
 * protocol-owned; the impl that resolves a connection to its narrowed arm and
 * runs each cap's derive/obtain is a server concern, supplied as a per-socket
 * `Layer` over the descriptor. This preserves the one-way protocol→server edge:
 * the protocol declares WHICH proof each method provides (shape projected from
 * the descriptor's `callablePrincipal` + `caps`); the server provides the
 * runtime.
 *
 * `failure: WireErrorSchema` types the gate/cap rejection as the same coded wire
 * envelope every member's `error` carries. Non-optional (no `optional: true`):
 * an optional middleware's runtime fold falls through to the handler on failure,
 * which would let a rejected principal/cap reach the body — the gate must
 * HARD-fail.
 *
 * The proof VALUE type per method is PROJECTED from the descriptor
 * (`AuthProof&lt;typeof D&gt;` reads `D["callablePrincipal"]` + `D["caps"]`),
 * never a parallel literal, so a descriptor edit that flips the principal or
 * adds a cap reshapes the proof in lockstep.
 */
import { Context } from "effect";
import { RpcMiddleware } from "@effect/rpc";
import type { AuthContextValue } from "./auth-context.js";
import type { RpcDefinition } from "./method.js";
import { WireErrorSchema } from "./rpc-method-groups.js";

import {
  AgentsList,
  AgentsLookup,
  AgentsLookupByName,
} from "../identity/agents.js";
import {
  ContactsAccept,
  ContactsAdd,
  ContactsById,
  ContactsList,
} from "../identity/contacts.js";
import { MessagesList, MessagesSend } from "../task/messages.js";
import {
  TaskAddParticipant,
  TaskClose,
  TaskConversationAddParticipant,
  TaskConversationArchive,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationRemoveParticipant,
  TaskConversationUnarchive,
  TaskLeave,
  TaskList,
  TaskRemoveParticipant,
  TaskRequest,
} from "../task/tasks.js";
import { NetworkPing, PresenceSubscribe } from "../network/methods.js";
import {
  AppsRegister,
  DispatchRequest,
  DispatchesGet,
} from "../app/methods.js";

/**
 * The combined proof value for one descriptor: the method-narrowed principal +
 * the cap proofs, both projected from the descriptor's own
 * `callablePrincipal`/`caps` (not re-declared). A descriptor whose
 * `callablePrincipal` is `"agent"` carries an agent-narrowed `principal`; adding
 * a cap to its `caps` adds that cap's proof field.
 */
export type AuthProof<D> =
  D extends RpcDefinition<string, infer _P, infer _R, infer K, infer Caps>
    ? AuthContextValue<K, Caps>
    : never;

// ── Agent-callable methods ──────────────────────────────────────────────

/** `messages/send` proof: agent principal + `ConversationInTask` + `MessageSendPermission`. */
export class MessagesSendAuth extends Context.Tag(
  "@moltzap/protocol/auth/messages-send",
)<MessagesSendAuth, AuthProof<typeof MessagesSend>>() {}
export class MessagesSendAuthMw extends RpcMiddleware.Tag<MessagesSendAuthMw>()(
  "@moltzap/protocol/auth/mw/messages-send",
  { provides: MessagesSendAuth, failure: WireErrorSchema },
) {}

/** `messages/list` proof: agent principal + `TaskReadAccess` + `ConversationInTask`. */
export class MessagesListAuth extends Context.Tag(
  "@moltzap/protocol/auth/messages-list",
)<MessagesListAuth, AuthProof<typeof MessagesList>>() {}
export class MessagesListAuthMw extends RpcMiddleware.Tag<MessagesListAuthMw>()(
  "@moltzap/protocol/auth/mw/messages-list",
  { provides: MessagesListAuth, failure: WireErrorSchema },
) {}

/** `task/list` proof: agent principal, no caps. */
export class TaskListAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-list",
)<TaskListAuth, AuthProof<typeof TaskList>>() {}
export class TaskListAuthMw extends RpcMiddleware.Tag<TaskListAuthMw>()(
  "@moltzap/protocol/auth/mw/task-list",
  { provides: TaskListAuth, failure: WireErrorSchema },
) {}

/** `task/request` proof: agent principal + `ContactPolicyAllowsReach`. */
export class TaskRequestAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-request",
)<TaskRequestAuth, AuthProof<typeof TaskRequest>>() {}
export class TaskRequestAuthMw extends RpcMiddleware.Tag<TaskRequestAuthMw>()(
  "@moltzap/protocol/auth/mw/task-request",
  { provides: TaskRequestAuth, failure: WireErrorSchema },
) {}

/** `task/leave` proof: agent principal, no caps. */
export class TaskLeaveAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-leave",
)<TaskLeaveAuth, AuthProof<typeof TaskLeave>>() {}
export class TaskLeaveAuthMw extends RpcMiddleware.Tag<TaskLeaveAuthMw>()(
  "@moltzap/protocol/auth/mw/task-leave",
  { provides: TaskLeaveAuth, failure: WireErrorSchema },
) {}

/** `task/conversation/list` proof: agent principal, no caps. */
export class TaskConversationListAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-conversation-list",
)<TaskConversationListAuth, AuthProof<typeof TaskConversationList>>() {}
export class TaskConversationListAuthMw extends RpcMiddleware.Tag<TaskConversationListAuthMw>()(
  "@moltzap/protocol/auth/mw/task-conversation-list",
  { provides: TaskConversationListAuth, failure: WireErrorSchema },
) {}

/** `agents/lookup` proof: agent principal, no caps. */
export class AgentsLookupAuth extends Context.Tag(
  "@moltzap/protocol/auth/agents-lookup",
)<AgentsLookupAuth, AuthProof<typeof AgentsLookup>>() {}
export class AgentsLookupAuthMw extends RpcMiddleware.Tag<AgentsLookupAuthMw>()(
  "@moltzap/protocol/auth/mw/agents-lookup",
  { provides: AgentsLookupAuth, failure: WireErrorSchema },
) {}

/** `agents/lookupByName` proof: agent principal, no caps. */
export class AgentsLookupByNameAuth extends Context.Tag(
  "@moltzap/protocol/auth/agents-lookup-by-name",
)<AgentsLookupByNameAuth, AuthProof<typeof AgentsLookupByName>>() {}
export class AgentsLookupByNameAuthMw extends RpcMiddleware.Tag<AgentsLookupByNameAuthMw>()(
  "@moltzap/protocol/auth/mw/agents-lookup-by-name",
  { provides: AgentsLookupByNameAuth, failure: WireErrorSchema },
) {}

/** `agents/list` proof: agent principal, no caps. */
export class AgentsListAuth extends Context.Tag(
  "@moltzap/protocol/auth/agents-list",
)<AgentsListAuth, AuthProof<typeof AgentsList>>() {}
export class AgentsListAuthMw extends RpcMiddleware.Tag<AgentsListAuthMw>()(
  "@moltzap/protocol/auth/mw/agents-list",
  { provides: AgentsListAuth, failure: WireErrorSchema },
) {}

/** `contacts/list` proof: agent principal, no caps. */
export class ContactsListAuth extends Context.Tag(
  "@moltzap/protocol/auth/contacts-list",
)<ContactsListAuth, AuthProof<typeof ContactsList>>() {}
export class ContactsListAuthMw extends RpcMiddleware.Tag<ContactsListAuthMw>()(
  "@moltzap/protocol/auth/mw/contacts-list",
  { provides: ContactsListAuth, failure: WireErrorSchema },
) {}

/** `contacts/add` proof: agent principal, no caps. */
export class ContactsAddAuth extends Context.Tag(
  "@moltzap/protocol/auth/contacts-add",
)<ContactsAddAuth, AuthProof<typeof ContactsAdd>>() {}
export class ContactsAddAuthMw extends RpcMiddleware.Tag<ContactsAddAuthMw>()(
  "@moltzap/protocol/auth/mw/contacts-add",
  { provides: ContactsAddAuth, failure: WireErrorSchema },
) {}

/** `contacts/accept` proof: agent principal, no caps. */
export class ContactsAcceptAuth extends Context.Tag(
  "@moltzap/protocol/auth/contacts-accept",
)<ContactsAcceptAuth, AuthProof<typeof ContactsAccept>>() {}
export class ContactsAcceptAuthMw extends RpcMiddleware.Tag<ContactsAcceptAuthMw>()(
  "@moltzap/protocol/auth/mw/contacts-accept",
  { provides: ContactsAcceptAuth, failure: WireErrorSchema },
) {}

/** `contacts/byId` proof: agent principal, no caps. */
export class ContactsByIdAuth extends Context.Tag(
  "@moltzap/protocol/auth/contacts-by-id",
)<ContactsByIdAuth, AuthProof<typeof ContactsById>>() {}
export class ContactsByIdAuthMw extends RpcMiddleware.Tag<ContactsByIdAuthMw>()(
  "@moltzap/protocol/auth/mw/contacts-by-id",
  { provides: ContactsByIdAuth, failure: WireErrorSchema },
) {}

/** `dispatch/request` proof: agent principal, no caps. */
export class DispatchRequestAuth extends Context.Tag(
  "@moltzap/protocol/auth/dispatch-request",
)<DispatchRequestAuth, AuthProof<typeof DispatchRequest>>() {}
export class DispatchRequestAuthMw extends RpcMiddleware.Tag<DispatchRequestAuthMw>()(
  "@moltzap/protocol/auth/mw/dispatch-request",
  { provides: DispatchRequestAuth, failure: WireErrorSchema },
) {}

/** `network/ping` proof: agent principal, no caps. */
export class NetworkPingAuth extends Context.Tag(
  "@moltzap/protocol/auth/network-ping",
)<NetworkPingAuth, AuthProof<typeof NetworkPing>>() {}
export class NetworkPingAuthMw extends RpcMiddleware.Tag<NetworkPingAuthMw>()(
  "@moltzap/protocol/auth/mw/network-ping",
  { provides: NetworkPingAuth, failure: WireErrorSchema },
) {}

/** `presence/subscribe` proof: agent principal, no caps. */
export class PresenceSubscribeAuth extends Context.Tag(
  "@moltzap/protocol/auth/presence-subscribe",
)<PresenceSubscribeAuth, AuthProof<typeof PresenceSubscribe>>() {}
export class PresenceSubscribeAuthMw extends RpcMiddleware.Tag<PresenceSubscribeAuthMw>()(
  "@moltzap/protocol/auth/mw/presence-subscribe",
  { provides: PresenceSubscribeAuth, failure: WireErrorSchema },
) {}

// ── App-callable methods ────────────────────────────────────────────────

/** `task/close` proof: app principal, no caps. */
export class TaskCloseAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-close",
)<TaskCloseAuth, AuthProof<typeof TaskClose>>() {}
export class TaskCloseAuthMw extends RpcMiddleware.Tag<TaskCloseAuthMw>()(
  "@moltzap/protocol/auth/mw/task-close",
  { provides: TaskCloseAuth, failure: WireErrorSchema },
) {}

/** `task/addParticipant` proof: app principal, no caps. */
export class TaskAddParticipantAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-add-participant",
)<TaskAddParticipantAuth, AuthProof<typeof TaskAddParticipant>>() {}
export class TaskAddParticipantAuthMw extends RpcMiddleware.Tag<TaskAddParticipantAuthMw>()(
  "@moltzap/protocol/auth/mw/task-add-participant",
  { provides: TaskAddParticipantAuth, failure: WireErrorSchema },
) {}

/** `task/removeParticipant` proof: app principal, no caps. */
export class TaskRemoveParticipantAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-remove-participant",
)<TaskRemoveParticipantAuth, AuthProof<typeof TaskRemoveParticipant>>() {}
export class TaskRemoveParticipantAuthMw extends RpcMiddleware.Tag<TaskRemoveParticipantAuthMw>()(
  "@moltzap/protocol/auth/mw/task-remove-participant",
  { provides: TaskRemoveParticipantAuth, failure: WireErrorSchema },
) {}

/** `task/conversation/create` proof: app principal, no caps. */
export class TaskConversationCreateAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-conversation-create",
)<TaskConversationCreateAuth, AuthProof<typeof TaskConversationCreate>>() {}
export class TaskConversationCreateAuthMw extends RpcMiddleware.Tag<TaskConversationCreateAuthMw>()(
  "@moltzap/protocol/auth/mw/task-conversation-create",
  { provides: TaskConversationCreateAuth, failure: WireErrorSchema },
) {}

/** `task/conversation/archive` proof: app principal + `ConversationInTask`. */
export class TaskConversationArchiveAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-conversation-archive",
)<TaskConversationArchiveAuth, AuthProof<typeof TaskConversationArchive>>() {}
export class TaskConversationArchiveAuthMw extends RpcMiddleware.Tag<TaskConversationArchiveAuthMw>()(
  "@moltzap/protocol/auth/mw/task-conversation-archive",
  { provides: TaskConversationArchiveAuth, failure: WireErrorSchema },
) {}

/** `task/conversation/unarchive` proof: app principal + `ConversationInTask`. */
export class TaskConversationUnarchiveAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-conversation-unarchive",
)<
  TaskConversationUnarchiveAuth,
  AuthProof<typeof TaskConversationUnarchive>
>() {}
export class TaskConversationUnarchiveAuthMw extends RpcMiddleware.Tag<TaskConversationUnarchiveAuthMw>()(
  "@moltzap/protocol/auth/mw/task-conversation-unarchive",
  { provides: TaskConversationUnarchiveAuth, failure: WireErrorSchema },
) {}

/** `task/conversation/participants/add` proof: app principal + `ConversationInTask`. */
export class TaskConversationAddParticipantAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-conversation-add-participant",
)<
  TaskConversationAddParticipantAuth,
  AuthProof<typeof TaskConversationAddParticipant>
>() {}
export class TaskConversationAddParticipantAuthMw extends RpcMiddleware.Tag<TaskConversationAddParticipantAuthMw>()(
  "@moltzap/protocol/auth/mw/task-conversation-add-participant",
  { provides: TaskConversationAddParticipantAuth, failure: WireErrorSchema },
) {}

/** `task/conversation/participants/remove` proof: app principal + `ConversationInTask`. */
export class TaskConversationRemoveParticipantAuth extends Context.Tag(
  "@moltzap/protocol/auth/task-conversation-remove-participant",
)<
  TaskConversationRemoveParticipantAuth,
  AuthProof<typeof TaskConversationRemoveParticipant>
>() {}
export class TaskConversationRemoveParticipantAuthMw extends RpcMiddleware.Tag<TaskConversationRemoveParticipantAuthMw>()(
  "@moltzap/protocol/auth/mw/task-conversation-remove-participant",
  { provides: TaskConversationRemoveParticipantAuth, failure: WireErrorSchema },
) {}

/** `apps/register` proof: app principal, no caps. */
export class AppsRegisterAuth extends Context.Tag(
  "@moltzap/protocol/auth/apps-register",
)<AppsRegisterAuth, AuthProof<typeof AppsRegister>>() {}
export class AppsRegisterAuthMw extends RpcMiddleware.Tag<AppsRegisterAuthMw>()(
  "@moltzap/protocol/auth/mw/apps-register",
  { provides: AppsRegisterAuth, failure: WireErrorSchema },
) {}

/** `dispatches/get` proof: app principal, no caps. */
export class DispatchesGetAuth extends Context.Tag(
  "@moltzap/protocol/auth/dispatches-get",
)<DispatchesGetAuth, AuthProof<typeof DispatchesGet>>() {}
export class DispatchesGetAuthMw extends RpcMiddleware.Tag<DispatchesGetAuthMw>()(
  "@moltzap/protocol/auth/mw/dispatches-get",
  { provides: DispatchesGetAuth, failure: WireErrorSchema },
) {}

/**
 * The `wire method name → that method's *AuthMw` registry. The single source the
 * engine group reads to attach each authenticated member's OWN middleware
 * (`server-engine-group.ts → buildEngineMember`/`EngineRpcFromDef`); the type
 * {@link AuthMiddlewareByMethod} is the type-level map the per-tag conditional
 * indexes. `network/connect` is absent (it is unauthenticated, no middleware).
 *
 * Keyed by the literal wire name so the engine's per-tag attach and the proof
 * tag each member provides stay in lockstep with the descriptor catalog: a new
 * authenticated method that forgets its `*AuthMw` entry is not in this map, so
 * the partition canary (`server-engine-group.types-check.ts`) leaves it ungated
 * and fails the build.
 */
export const authMiddlewareByMethod = {
  "messages/send": MessagesSendAuthMw,
  "messages/list": MessagesListAuthMw,
  "task/list": TaskListAuthMw,
  "task/request": TaskRequestAuthMw,
  "task/leave": TaskLeaveAuthMw,
  "task/conversation/list": TaskConversationListAuthMw,
  "agents/lookup": AgentsLookupAuthMw,
  "agents/lookupByName": AgentsLookupByNameAuthMw,
  "agents/list": AgentsListAuthMw,
  "contacts/list": ContactsListAuthMw,
  "contacts/add": ContactsAddAuthMw,
  "contacts/accept": ContactsAcceptAuthMw,
  "contacts/byId": ContactsByIdAuthMw,
  "dispatch/request": DispatchRequestAuthMw,
  "network/ping": NetworkPingAuthMw,
  "presence/subscribe": PresenceSubscribeAuthMw,
  "task/close": TaskCloseAuthMw,
  "task/addParticipant": TaskAddParticipantAuthMw,
  "task/removeParticipant": TaskRemoveParticipantAuthMw,
  "task/conversation/create": TaskConversationCreateAuthMw,
  "task/conversation/archive": TaskConversationArchiveAuthMw,
  "task/conversation/unarchive": TaskConversationUnarchiveAuthMw,
  "task/conversation/participants/add": TaskConversationAddParticipantAuthMw,
  "task/conversation/participants/remove":
    TaskConversationRemoveParticipantAuthMw,
  "apps/register": AppsRegisterAuthMw,
  "dispatches/get": DispatchesGetAuthMw,
} as const;

/** The type-level `name → *AuthMw` map the engine's per-tag conditional indexes. */
export type AuthMiddlewareByMethod = typeof authMiddlewareByMethod;
