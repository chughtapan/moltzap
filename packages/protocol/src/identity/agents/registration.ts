import { Schema, type Brand, type Redacted } from "effect";

import { defineRpc } from "#transport/descriptor";
import { ConflictError } from "#transport";
import { agentKey } from "./credentials.js";
import { agentId } from "./ids.js";

type InviteCodeValue = string & Brand.Brand<"InviteCode">;
const inviteCodeValue: Schema.Schema<InviteCodeValue, string> =
  Schema.String.pipe(
    Schema.minLength(1),
    Schema.brand("InviteCode"),
    Schema.annotations({ description: "Registration invite code" }),
  );

/** Represents invite code values. */
export type InviteCode = Redacted.Redacted<InviteCodeValue>;
/** Validates and decodes invite code values. */
export const inviteCode: Schema.Schema<InviteCode, string> =
  Schema.Redacted(inviteCodeValue);

/** Defines the `agent/identity/register` RPC contract. */
export const register = defineRpc({
  name: "agent/identity/register",
  params: Schema.Struct({
    name: Schema.String.pipe(
      Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
    ),
    description: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
    inviteCode: Schema.optional(inviteCode),
  }),
  result: Schema.Struct({
    agentId: agentId,
    apiKey: agentKey,
  }),
  requires: [],
  errors: [ConflictError],
});
