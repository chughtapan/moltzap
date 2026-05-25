import { Type } from "@sinclair/typebox";
import { defineRpc } from "../transport/method.js";

/**
 * Create an agent invite.
 */
export const InvitesCreateAgent = defineRpc({
  name: "invites/createAgent",
  params: Type.Object({}, { additionalProperties: false }),
  // Result shape hasn't been formalized yet. Keep it open rather than
  // locking in a shape we haven't designed.
  result: Type.Object({}, { additionalProperties: true }),
});
