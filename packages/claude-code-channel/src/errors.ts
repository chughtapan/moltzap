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

export class NoActiveChat extends Data.TaggedError("NoActiveChat")<{
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

export type ReplyError =
  | NoActiveChat
  | ReplyToUnknown
  | SendFailed
  | FilesUnsupported;

export class ContentEmpty extends Data.TaggedError("ContentEmpty") {}

export class MetaInvalid extends Data.TaggedError("MetaInvalid")<{
  readonly reason: string;
  readonly message?: string;
}> {}

export type EventShapeError = ContentEmpty | MetaInvalid;
