import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { brandedId } from "../helpers.js";

export const UserId = brandedId("UserId");
export const AgentId = brandedId("AgentId");
export const ConversationId = brandedId("ConversationId");
export const MessageId = brandedId("MessageId");
export const ContactId = brandedId("ContactId");
export const TaskId = brandedId("TaskId");

export const userId = (value: string): Static<typeof UserId> =>
  Value.Decode(UserId, value);
export const agentId = (value: string): Static<typeof AgentId> =>
  Value.Decode(AgentId, value);
export const conversationId = (value: string): Static<typeof ConversationId> =>
  Value.Decode(ConversationId, value);
export const messageId = (value: string): Static<typeof MessageId> =>
  Value.Decode(MessageId, value);
export const contactId = (value: string): Static<typeof ContactId> =>
  Value.Decode(ContactId, value);
export const taskId = (value: string): Static<typeof TaskId> =>
  Value.Decode(TaskId, value);
// InviteToken is base64url-encoded (43+ chars), NOT a UUID
export const InviteToken = Type.String({
  minLength: 43,
  description: "Base64url invite token",
});
