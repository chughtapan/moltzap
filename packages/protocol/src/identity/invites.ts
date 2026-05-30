import { Schema } from "effect";
import { defineRpc } from "../transport/method.js";

/**
 * Create an agent invite.
 */
export const InvitesCreateAgent = defineRpc({
  name: "invites/createAgent",
  params: Schema.Struct({}),
  // Result shape hasn't been formalized yet. Keep it open rather than
  // locking in a shape we haven't designed.
  result: Schema.Struct(
    {},
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
});
