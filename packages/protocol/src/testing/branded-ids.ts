import { type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { UserId, AgentId, ContactId } from "../identity/methods.js";
import { ConversationId, MessageId, TaskId } from "../task/methods.js";

// Test-fixture brand-decoders. Production code never validates IDs at the
// caller — `defineRpc(...).validateParams` is the single validation site.
// Tests + eval harnesses use these to construct branded values from UUID
// string literals.

export const userId = (value: string): Static<typeof UserId> =>
  Value.Decode(UserId, value);
export const agentId = (value: string): Static<typeof AgentId> =>
  Value.Decode(AgentId, value);
export const contactId = (value: string): Static<typeof ContactId> =>
  Value.Decode(ContactId, value);
export const conversationId = (value: string): Static<typeof ConversationId> =>
  Value.Decode(ConversationId, value);
export const messageId = (value: string): Static<typeof MessageId> =>
  Value.Decode(MessageId, value);
export const taskId = (value: string): Static<typeof TaskId> =>
  Value.Decode(TaskId, value);
