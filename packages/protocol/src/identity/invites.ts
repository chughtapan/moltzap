import { Schema } from "effect";
import { defineRpc } from "../transport/method.js";

/**
 * Create an agent invite.
 */
export const InvitesCreateAgent = defineRpc({
  name: "invites/createAgent",
  params: Schema.Struct({}),
  // Open result shape: accepts any string-keyed record so the
  // response is not locked to an unformalized shape.
  result: Schema.Struct(
    {},
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  errors: [],
});
