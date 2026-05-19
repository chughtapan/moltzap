import { Data } from "effect";
import type { ServiceRpcError } from "@moltzap/client";
import { LeaseAlreadyConsumed } from "@moltzap/client/channel-base";

// Re-export the canonical `LeaseAlreadyConsumed` from `@moltzap/client/channel-base`
// so existing consumers of `claude-code-channel/errors` continue to import the
// same name. The single definition site lives at
// `packages/client/src/channel-base/lease.ts → LeaseAlreadyConsumed` per
// spec C (#597) invariant: one canonical class across all three channels.
export { LeaseAlreadyConsumed };

export class McpTransportFailed extends Data.TaggedError("McpTransportFailed")<{
  readonly cause: string;
}> {}

export class AgentKeyInvalid extends Data.TaggedError("AgentKeyInvalid")<{
  readonly cause: string;
}> {}

class SchemaDecodeFailed extends Data.TaggedError("SchemaDecodeFailed")<{
  readonly cause: string;
  readonly at: "ws" | "mcp";
}> {}

export type BootError =
  | ServiceRpcError
  | McpTransportFailed
  | AgentKeyInvalid
  | SchemaDecodeFailed;

export class EmitFailed extends Data.TaggedError("EmitFailed")<{
  readonly cause: string;
}> {}

class NotConnected extends Data.TaggedError("NotConnected")<{
  readonly cause: string;
}> {}

export type PushError = EmitFailed | NotConnected;

class SenderNotAllowed extends Data.TaggedError("SenderNotAllowed")<{
  readonly senderId: string;
  readonly reason: string;
}> {}

class ConversationNotAllowed extends Data.TaggedError(
  "ConversationNotAllowed",
)<{
  readonly conversationId: string;
  readonly reason: string;
}> {}

export type AllowlistError = SenderNotAllowed | ConversationNotAllowed;

class NoActiveConversation extends Data.TaggedError("NoActiveConversation")<{
  readonly cause: string;
}> {}

class ReplyToUnknown extends Data.TaggedError("ReplyToUnknown")<{
  readonly replyTo: string;
}> {}

export class SendFailed extends Data.TaggedError("SendFailed")<{
  readonly cause: string;
}> {}

class FilesUnsupported extends Data.TaggedError("FilesUnsupported")<{
  readonly fileCount: number;
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
