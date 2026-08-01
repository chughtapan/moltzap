import { type Brand, type Redacted, Schema } from "effect";

import { defineRpc } from "#transport/descriptor";
import { ConflictError } from "#transport";
import { AgentKey } from "./credentials.js";
import { AgentId } from "./ids.js";

type InviteCodeValue = string & Brand.Brand<"InviteCode">;
const InviteCodeValue: Schema.Schema<InviteCodeValue, string> =
  Schema.String.pipe(
    Schema.minLength(1),
    Schema.brand("InviteCode"),
    Schema.annotations({ description: "Registration invite code" }),
  );

export type InviteCode = Redacted.Redacted<InviteCodeValue>;
export const InviteCode: Schema.Schema<InviteCode, string> =
  Schema.Redacted(InviteCodeValue);

export const Register = defineRpc({
  name: "agent/identity/register",
  params: Schema.Struct({
    name: Schema.String.pipe(
      Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
    ),
    description: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
    inviteCode: Schema.optional(InviteCode),
  }),
  result: Schema.Struct({
    agentId: AgentId,
    apiKey: AgentKey,
  }),
  requires: [],
  errors: [ConflictError],
});
