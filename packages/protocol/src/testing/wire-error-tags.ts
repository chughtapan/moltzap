/**
 * @file Named wire-error `_tag` discriminants for test assertions.
 *
 * The wire `error` is a `_tag`-discriminated tagged error. Tests assert on that
 * discriminant; these named constants give the contractual tag a single import
 * site so an assertion does not hard-code a magic string (and a tag rename
 * surfaces as one edit here, not a scattered string hunt).
 */
export const WIRE_ERROR_TAG = {
  Unauthorized: "Unauthorized",
  Forbidden: "Forbidden",
  NotFound: "NotFound",
  Conflict: "Conflict",
  InvalidParams: "InvalidParamsError",
  AlreadyConnected: "AlreadyConnected",
  ProtocolMismatch: "ProtocolMismatchError",
  TaskClosed: "TaskClosed",
  TaskNotFound: "TaskNotFound",
  TaskRejected: "TaskRejected",
  HookBlocked: "HookBlocked",
  ParticipantNotAdmitted: "ParticipantNotAdmitted",
  ConversationArchived: "ConversationArchived",
  ConversationFull: "ConversationFull",
  ConversationNotFound: "ConversationNotFound",
  MessageNotFound: "MessageNotFound",
  AgentNotFound: "AgentNotFound",
  NotAParticipant: "NotAParticipant",
  NotInContacts: "NotInContacts",
  ContactNotFound: "ContactNotFound",
  DispatchNotFound: "DispatchNotFound",
} as const;
