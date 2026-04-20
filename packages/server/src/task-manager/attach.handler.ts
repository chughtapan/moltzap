import { Context, Data, Effect } from "effect";
import type {
  AgentId,
  AppId,
  ConversationId,
  TaskId,
} from "@moltzap/protocol/task";

export class AttachUnauthorized extends Data.TaggedError("AttachUnauthorized")<{
  readonly taskId: TaskId;
  readonly callerAgentId: AgentId | null;
  readonly callerAppId: AppId | null;
}> {}

export class AttachTaskNotFound extends Data.TaggedError("AttachTaskNotFound")<{
  readonly taskId: TaskId;
}> {}

export class AttachConversationConflict extends Data.TaggedError(
  "AttachConversationConflict",
)<{
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly reason: "already_attached_to_other_task" | "dm_immutable";
}> {}

export class AttachParticipantInvalid extends Data.TaggedError(
  "AttachParticipantInvalid",
)<{
  readonly taskId: TaskId;
  readonly participantId: AgentId;
  readonly reason: "not_a_task_participant" | "duplicate" | "unknown_agent";
}> {}

export type AttachConversationError =
  | AttachUnauthorized
  | AttachTaskNotFound
  | AttachConversationConflict
  | AttachParticipantInvalid;

export interface AttachCallerIdentity {
  readonly callerAgentId: AgentId | null;
  readonly callerAppId: AppId | null;
}

export interface AttachConversationParams {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly participantIds: readonly AgentId[];
}

export interface AttachConversationResult {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly participantIds: readonly AgentId[];
}

export interface AttachConversationHandler {
  readonly attach: (
    params: AttachConversationParams,
    identity: AttachCallerIdentity,
  ) => Effect.Effect<AttachConversationResult, AttachConversationError, never>;
}

export class AttachConversationHandlerTag extends Context.Tag(
  "AttachConversationHandler",
)<AttachConversationHandlerTag, AttachConversationHandler>() {}

export const makeAttachConversationHandler = (): Effect.Effect<
  AttachConversationHandler,
  never,
  never
> => {
  throw new Error("not implemented");
};
