import { Type } from "@sinclair/typebox";
import { defineRpc } from "../../rpc.js";

export const InvitesCreateAgent = defineRpc({
  name: "invites/createAgent",
  params: Type.Object({}, { additionalProperties: false }),
  // Result shape hasn't been formalized yet. Keep it open rather than
  // locking in a shape we haven't designed.
  result: Type.Object({}, { additionalProperties: true }),
});
