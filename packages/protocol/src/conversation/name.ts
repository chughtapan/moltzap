import { Schema } from "effect";

/** Display name accepted when a conversation is created. */
export const ConversationNameSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(100),
);
