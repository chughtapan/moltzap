import { Data } from "effect";
import type { Effect } from "effect";
import type { MoltZapService, ServiceRpcError } from "@moltzap/client";
import { LeaseAlreadyConsumed } from "@moltzap/client/channel-base";

// `LeaseAlreadyConsumed` has one canonical definition site shared across all
// three channels: `packages/client/src/channel-base/lease.ts → LeaseAlreadyConsumed`.
export { LeaseAlreadyConsumed };

export class McpTransportFailed extends Data.TaggedError("McpTransportFailed")<{
  readonly cause: string;
}> {}

class SchemaDecodeFailed extends Data.TaggedError("SchemaDecodeFailed")<{
  readonly cause: string;
  readonly at: "ws" | "mcp";
}> {}

type ClientBootConfigError = Effect.Effect.Error<
  ReturnType<typeof MoltZapService.make>
>;

export type BootError =
  | ClientBootConfigError
  | ServiceRpcError
  | McpTransportFailed
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
