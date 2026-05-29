export * from "./conversations.js";
export * from "./messages.js";
export * from "./tasks.js";

import { MessagesSend, MessagesList } from "./messages.js";
import { MessageReceivedNotificationDefinition } from "./messages.js";
import {
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  // Spec D1 (#598) `task/*` + `task/conversation/*` surface (singular).
  TaskRequest,
  TaskLeave,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
} from "./tasks.js";

export const taskRpcMethods = [
  MessagesSend,
  MessagesList,
  TaskRequest,
  TaskLeave,
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
] as const;

// Spec D3 R11 — per-kind subsets of the surviving task layer. The
// `agentCallable` / `appCallable` split is the OUTBOUND client catalog
// partition: which task RPCs a `MoltZapAgentClient` may originate vs which
// an app/TM client may. (Renamed from `nonTmAuthority` / `tmOnly` under
// D #705 Decision 1 — the `TmAuthority` capability is dissolved; the
// partition survives, the names no longer encode the dissolved capability.)
export const agentCallableTaskRpcMethods = [
  TaskRequest,
  TaskList,
  TaskLeave,
  MessagesSend,
  MessagesList,
] as const;

export const appCallableTaskRpcMethods = [
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskConversationCreate,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
] as const;

export const taskNotifications = [
  MessageReceivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  // Spec D3 canonical: only the task/conversation/* set survives the
  // `conversations/*` notification deletion.
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
] as const;
