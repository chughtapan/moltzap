/**
 * @file Type canary for the per-method `AuthMiddleware` impl Layers
 * (`transport/auth-middleware-layers.ts`).
 *
 * The factories are built ahead of the native-engine cutover and are bound to no
 * engine yet. This canary is their live type consumer AND pins the per-socket
 * scope encoding each factory's design relies on:
 *
 *   - every factory CLOSES OVER a `ConnectionId` — there is no app-level shared
 *     instance that would collide every connection on the constant mux clientId;
 *   - each produces a `Layer` that PROVIDES exactly its method's `*AuthMw`
 *     descriptor (the protocol-owned proof-providing middleware Tag), so a
 *     factory wired to the wrong descriptor stops compiling;
 *   - the cap-LESS factories require only `ConnectionManagerTag`; the cap-BEARING
 *     factories additionally require the cap obtains' service env (`MwEnv`), so a
 *     factory that forgets to run its caps under the services drops `MwEnv` from
 *     its requirement channel and fails this canary.
 *
 * If a factory loses its `connId` parameter, provides the wrong `*AuthMw`, or a
 * cap-bearing factory drops `MwEnv`, the equalities below stop compiling.
 */
import type { Layer } from "effect";
import type {
  MessagesSendAuthMw,
  MessagesListAuthMw,
  TaskListAuthMw,
  TaskRequestAuthMw,
  TaskLeaveAuthMw,
  TaskConversationListAuthMw,
  AgentsLookupAuthMw,
  AgentsLookupByNameAuthMw,
  AgentsListAuthMw,
  ContactsListAuthMw,
  ContactsAddAuthMw,
  ContactsAcceptAuthMw,
  ContactsByIdAuthMw,
  DispatchRequestAuthMw,
  NetworkPingAuthMw,
  PresenceSubscribeAuthMw,
  TaskCloseAuthMw,
  TaskAddParticipantAuthMw,
  TaskRemoveParticipantAuthMw,
  TaskConversationCreateAuthMw,
  TaskConversationArchiveAuthMw,
  TaskConversationUnarchiveAuthMw,
  TaskConversationAddParticipantAuthMw,
  TaskConversationRemoveParticipantAuthMw,
  AppsRegisterAuthMw,
  DispatchesGetAuthMw,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import type {
  ConnectionManagerTag,
  ConversationServiceTag,
  MessageServiceTag,
  TaskServiceTag,
} from "../app/layers.js";
import {
  makeMessagesSendAuthMwLayer,
  makeMessagesListAuthMwLayer,
  makeTaskListAuthMwLayer,
  makeTaskRequestAuthMwLayer,
  makeTaskLeaveAuthMwLayer,
  makeTaskConversationListAuthMwLayer,
  makeAgentsLookupAuthMwLayer,
  makeAgentsLookupByNameAuthMwLayer,
  makeAgentsListAuthMwLayer,
  makeContactsListAuthMwLayer,
  makeContactsAddAuthMwLayer,
  makeContactsAcceptAuthMwLayer,
  makeContactsByIdAuthMwLayer,
  makeDispatchRequestAuthMwLayer,
  makeNetworkPingAuthMwLayer,
  makePresenceSubscribeAuthMwLayer,
  makeTaskCloseAuthMwLayer,
  makeTaskAddParticipantAuthMwLayer,
  makeTaskRemoveParticipantAuthMwLayer,
  makeTaskConversationCreateAuthMwLayer,
  makeTaskConversationArchiveAuthMwLayer,
  makeTaskConversationUnarchiveAuthMwLayer,
  makeTaskConversationAddParticipantAuthMwLayer,
  makeTaskConversationRemoveParticipantAuthMwLayer,
  makeAppsRegisterAuthMwLayer,
  makeDispatchesGetAuthMwLayer,
} from "./auth-middleware-layers.js";

// Compile-time equality helper.
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

/** The cap obtains' service env (mirrors the module-private `MwEnv`). */
type MwEnv = TaskServiceTag | ConversationServiceTag | MessageServiceTag;

// Every factory closes over the per-connection key.
type _ClosesOverConnId = Expect<
  Equal<Parameters<typeof makeTaskListAuthMwLayer>[0], ConnectionId>
>;

// Cap-less factories provide exactly their `*AuthMw`, requiring only the manager.
type CapLessLayer<Mw> = Layer.Layer<Mw, never, ConnectionManagerTag>;
type _TaskList = Expect<
  Equal<
    ReturnType<typeof makeTaskListAuthMwLayer>,
    CapLessLayer<TaskListAuthMw>
  >
>;
type _TaskLeave = Expect<
  Equal<
    ReturnType<typeof makeTaskLeaveAuthMwLayer>,
    CapLessLayer<TaskLeaveAuthMw>
  >
>;
type _TaskConversationList = Expect<
  Equal<
    ReturnType<typeof makeTaskConversationListAuthMwLayer>,
    CapLessLayer<TaskConversationListAuthMw>
  >
>;
type _AgentsLookup = Expect<
  Equal<
    ReturnType<typeof makeAgentsLookupAuthMwLayer>,
    CapLessLayer<AgentsLookupAuthMw>
  >
>;
type _AgentsLookupByName = Expect<
  Equal<
    ReturnType<typeof makeAgentsLookupByNameAuthMwLayer>,
    CapLessLayer<AgentsLookupByNameAuthMw>
  >
>;
type _AgentsList = Expect<
  Equal<
    ReturnType<typeof makeAgentsListAuthMwLayer>,
    CapLessLayer<AgentsListAuthMw>
  >
>;
type _ContactsList = Expect<
  Equal<
    ReturnType<typeof makeContactsListAuthMwLayer>,
    CapLessLayer<ContactsListAuthMw>
  >
>;
type _ContactsAdd = Expect<
  Equal<
    ReturnType<typeof makeContactsAddAuthMwLayer>,
    CapLessLayer<ContactsAddAuthMw>
  >
>;
type _ContactsAccept = Expect<
  Equal<
    ReturnType<typeof makeContactsAcceptAuthMwLayer>,
    CapLessLayer<ContactsAcceptAuthMw>
  >
>;
type _ContactsById = Expect<
  Equal<
    ReturnType<typeof makeContactsByIdAuthMwLayer>,
    CapLessLayer<ContactsByIdAuthMw>
  >
>;
type _DispatchRequest = Expect<
  Equal<
    ReturnType<typeof makeDispatchRequestAuthMwLayer>,
    CapLessLayer<DispatchRequestAuthMw>
  >
>;
type _NetworkPing = Expect<
  Equal<
    ReturnType<typeof makeNetworkPingAuthMwLayer>,
    CapLessLayer<NetworkPingAuthMw>
  >
>;
type _PresenceSubscribe = Expect<
  Equal<
    ReturnType<typeof makePresenceSubscribeAuthMwLayer>,
    CapLessLayer<PresenceSubscribeAuthMw>
  >
>;
type _TaskClose = Expect<
  Equal<
    ReturnType<typeof makeTaskCloseAuthMwLayer>,
    CapLessLayer<TaskCloseAuthMw>
  >
>;
type _TaskAddParticipant = Expect<
  Equal<
    ReturnType<typeof makeTaskAddParticipantAuthMwLayer>,
    CapLessLayer<TaskAddParticipantAuthMw>
  >
>;
type _TaskRemoveParticipant = Expect<
  Equal<
    ReturnType<typeof makeTaskRemoveParticipantAuthMwLayer>,
    CapLessLayer<TaskRemoveParticipantAuthMw>
  >
>;
type _TaskConversationCreate = Expect<
  Equal<
    ReturnType<typeof makeTaskConversationCreateAuthMwLayer>,
    CapLessLayer<TaskConversationCreateAuthMw>
  >
>;
type _AppsRegister = Expect<
  Equal<
    ReturnType<typeof makeAppsRegisterAuthMwLayer>,
    CapLessLayer<AppsRegisterAuthMw>
  >
>;
type _DispatchesGet = Expect<
  Equal<
    ReturnType<typeof makeDispatchesGetAuthMwLayer>,
    CapLessLayer<DispatchesGetAuthMw>
  >
>;

// Cap-bearing factories additionally require `MwEnv` (the cap obtains' services).
type CapBearingLayer<Mw> = Layer.Layer<Mw, never, ConnectionManagerTag | MwEnv>;
type _MessagesSend = Expect<
  Equal<
    ReturnType<typeof makeMessagesSendAuthMwLayer>,
    CapBearingLayer<MessagesSendAuthMw>
  >
>;
type _MessagesList = Expect<
  Equal<
    ReturnType<typeof makeMessagesListAuthMwLayer>,
    CapBearingLayer<MessagesListAuthMw>
  >
>;
type _TaskRequest = Expect<
  Equal<
    ReturnType<typeof makeTaskRequestAuthMwLayer>,
    CapBearingLayer<TaskRequestAuthMw>
  >
>;
type _TaskConversationArchive = Expect<
  Equal<
    ReturnType<typeof makeTaskConversationArchiveAuthMwLayer>,
    CapBearingLayer<TaskConversationArchiveAuthMw>
  >
>;
type _TaskConversationUnarchive = Expect<
  Equal<
    ReturnType<typeof makeTaskConversationUnarchiveAuthMwLayer>,
    CapBearingLayer<TaskConversationUnarchiveAuthMw>
  >
>;
type _TaskConversationAddParticipant = Expect<
  Equal<
    ReturnType<typeof makeTaskConversationAddParticipantAuthMwLayer>,
    CapBearingLayer<TaskConversationAddParticipantAuthMw>
  >
>;
type _TaskConversationRemoveParticipant = Expect<
  Equal<
    ReturnType<typeof makeTaskConversationRemoveParticipantAuthMwLayer>,
    CapBearingLayer<TaskConversationRemoveParticipantAuthMw>
  >
>;

export type {
  _ClosesOverConnId,
  _TaskList,
  _TaskLeave,
  _TaskConversationList,
  _AgentsLookup,
  _AgentsLookupByName,
  _AgentsList,
  _ContactsList,
  _ContactsAdd,
  _ContactsAccept,
  _ContactsById,
  _DispatchRequest,
  _NetworkPing,
  _PresenceSubscribe,
  _TaskClose,
  _TaskAddParticipant,
  _TaskRemoveParticipant,
  _TaskConversationCreate,
  _AppsRegister,
  _DispatchesGet,
  _MessagesSend,
  _MessagesList,
  _TaskRequest,
  _TaskConversationArchive,
  _TaskConversationUnarchive,
  _TaskConversationAddParticipant,
  _TaskConversationRemoveParticipant,
};
