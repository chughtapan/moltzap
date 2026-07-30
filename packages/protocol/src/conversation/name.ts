// safer-arch-ignore folder-explicit-api-required: The conversation-name schema is a deliberate leaf contract shared by task and conversation descriptors.
import { Schema } from "effect";

/** Display name accepted when a conversation is created. */
export const conversationNameSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(100),
);
