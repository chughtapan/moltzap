import { Data } from "effect";

export class ServiceConnectFailed extends Data.TaggedError(
  "ServiceConnectFailed",
)<{
  readonly cause: string;
}> {}

export class McpTransportFailed extends Data.TaggedError("McpTransportFailed")<{
  readonly cause: string;
}> {}

export class AgentKeyInvalid extends Data.TaggedError("AgentKeyInvalid")<{
  readonly cause: string;
}> {}

export class SchemaDecodeFailed extends Data.TaggedError("SchemaDecodeFailed")<{
  readonly cause: string;
  readonly at: "ws" | "mcp";
}> {}

export type BootError =
  | ServiceConnectFailed
  | McpTransportFailed
  | AgentKeyInvalid
  | SchemaDecodeFailed;

export class EmitFailed extends Data.TaggedError("EmitFailed")<{
  readonly cause: string;
}> {}

export class NotConnected extends Data.TaggedError("NotConnected")<{
  readonly cause: string;
}> {}

export type PushError = EmitFailed | NotConnected;

export class SenderNotAllowed extends Data.TaggedError("SenderNotAllowed")<{
  readonly senderId: string;
  readonly reason: string;
}> {}

export class ConversationNotAllowed extends Data.TaggedError(
  "ConversationNotAllowed",
)<{
  readonly conversationId: string;
  readonly reason: string;
}> {}

export type AllowlistError = SenderNotAllowed | ConversationNotAllowed;

export class NoActiveConversation extends Data.TaggedError(
  "NoActiveConversation",
)<{
  readonly cause: string;
}> {}

export class ReplyToUnknown extends Data.TaggedError("ReplyToUnknown")<{
  readonly replyTo: string;
}> {}

export class SendFailed extends Data.TaggedError("SendFailed")<{
  readonly cause: string;
}> {}

export class FilesUnsupported extends Data.TaggedError("FilesUnsupported")<{
  readonly fileCount: number;
}> {}

/**
 * The lease attached to the in-flight dispatch was already consumed
 * (single-use semantics — cutover #533). Surfaced when a multi-turn
 * agent calls the `reply` MCP tool a second time within the same
 * dispatch context. The first call's `core.sendReply` succeeded; the
 * second sees `LeaseInvalidError(state=CONSUMED)` from the server,
 * which the entry mapper turns into this typed error before the
 * existing `mapError` collapses other failures into `SendFailed`.
 *
 * Caller surface: `server.ts` projects this onto a
 * `toolErrorResult("LeaseAlreadyConsumed: ...")`. Multi-turn
 * redesign of the tool's lease handling is a known follow-up
 * (architect plan §9 risk #3); this PR ships only the graceful
 * error path.
 */
export class LeaseAlreadyConsumed extends Data.TaggedError(
  "LeaseAlreadyConsumed",
)<{
  readonly leaseId: string;
}> {}

export type ReplyError =
  | NoActiveConversation
  | ReplyToUnknown
  | SendFailed
  | FilesUnsupported
  | LeaseAlreadyConsumed;

export class ContentEmpty extends Data.TaggedError("ContentEmpty") {}

export class MetaInvalid extends Data.TaggedError("MetaInvalid")<{
  readonly reason: string;
  readonly message?: string;
}> {}

export type EventShapeError = ContentEmpty | MetaInvalid;
