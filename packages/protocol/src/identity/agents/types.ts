import { Schema } from "effect";

import {
  closedStructGuard,
  dateTimeStringSchema,
  stringEnum,
  errorPayloadFields,
} from "#transport";
import { AgentId } from "./ids.js";
import { UserId } from "#identity/users";

const DateTimeString = dateTimeStringSchema();

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFound",
  errorPayloadFields,
) {
  static readonly message = "Agent not found";
}

const AgentMetadataSchema = Schema.Struct({
  purpose: Schema.optional(Schema.Array(Schema.String)),
  description: Schema.optional(Schema.String),
  tags: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});

const AgentSchema = Schema.Struct({
  id: AgentId,
  ownerUserId: Schema.optional(UserId),
  name: Schema.String.pipe(
    Schema.minLength(3),
    Schema.maxLength(32),
    Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
  ),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  agentType: Schema.optional(stringEnum(["OpenClaw", "NanoClaw"])),
  metadata: Schema.optional(AgentMetadataSchema),
  status: stringEnum(["active", "suspended"]),
  createdAt: DateTimeString,
});

export const AgentCardSchema = AgentSchema.omit("createdAt");

const AgentOwnershipSchema = Schema.Struct({
  agentId: AgentId,
  ownerUserId: UserId,
});

export type Agent = Schema.Schema.Type<typeof AgentSchema>;
export type AgentCard = Schema.Schema.Type<typeof AgentCardSchema>;

export const validateAgent = closedStructGuard(AgentSchema);
export const validateAgentCard = closedStructGuard(AgentCardSchema);

export function agentOwnershipSchema(): typeof AgentOwnershipSchema {
  return AgentOwnershipSchema;
}
