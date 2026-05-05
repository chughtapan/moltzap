export type { Agent, AgentCard } from "./schema/identity.js";
export type { Contact } from "./schema/contacts.js";
export type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "./schema/conversations.js";
export type {
  TextPart,
  ImagePart,
  FilePart,
  Part,
  Message,
} from "./schema/messages.js";
export type { Invite } from "./schema/invites.js";
export type { PresenceEntry } from "./schema/presence.js";
export type {
  RequestFrame,
  ResponseFrame,
  NotificationFrame,
} from "./schema/frames.js";
export type { RpcError, ErrorCode } from "./schema/errors.js";

// Auth shared shapes (not RPC params/results — those come from the manifest).
export type { HelloOk, OwnedAgent } from "./network/methods/auth.js";

// App shared shapes.
export type { AppManifest, AppManifestConversation } from "./schema/apps.js";

// Typed notification payloads (the `params` field of a `NotificationFrame`).
export type {
  MessageReceivedNotification,
  ConversationCreatedNotification,
  ConversationUpdatedNotification,
  ContactRequestNotification,
  ContactAcceptedNotification,
  PresenceChangedNotification,
  AppParticipantAdmittedNotification,
  AppParticipantRejectedNotification,
  TaskReadyNotification,
  TaskFailedNotification,
  TaskClosedNotification,
  TaskAdmissionCompleteNotification,
} from "./schema/notifications.js";

// RPC manifest-derived params/results aren't re-exported here; downstream
// consumers get types from `Static<typeof Manifest.paramsSchema>` /
// `Static<typeof Manifest.resultSchema>` at the import site.
