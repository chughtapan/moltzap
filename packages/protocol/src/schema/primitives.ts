import { Type } from "@sinclair/typebox";
import { brandedId } from "../helpers.js";

export const UserId = brandedId("UserId");
export const AgentId = brandedId("AgentId");
export const ConversationId = brandedId("ConversationId");
export const MessageId = brandedId("MessageId");
export const ContactId = brandedId("ContactId");
// InviteToken is base64url-encoded (43+ chars), NOT a UUID
export const InviteToken = Type.String({
  minLength: 43,
  description: "Base64url invite token",
});
