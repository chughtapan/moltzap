import { Data } from "effect";
import { Value } from "@sinclair/typebox/value";
import { ConversationId, MessageId } from "./conversations.js";
import { TaskId } from "./tasks.js";

export class BrandedIdDecodeError extends Data.TaggedError(
  "BrandedIdDecodeError",
)<{
  readonly kind: "TaskId" | "ConversationId" | "MessageId";
  readonly input: string;
  readonly cause: unknown;
}> {}

function brand<T>(
  kind: BrandedIdDecodeError["kind"],
  schema: unknown,
  value: string,
): T {
  try {
    return Value.Decode(schema as never, value) as T;
  } catch (cause) {
    throw new BrandedIdDecodeError({ kind, input: value, cause });
  }
}

export const brandTaskId = (value: string): TaskId =>
  brand<TaskId>("TaskId", TaskId, value);

export const brandConversationId = (value: string): ConversationId =>
  brand<ConversationId>("ConversationId", ConversationId, value);

export const brandMessageId = (value: string): MessageId =>
  brand<MessageId>("MessageId", MessageId, value);
