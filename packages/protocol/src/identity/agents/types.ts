import { Schema } from "effect";

import {
  closedStructGuard,
  dateTimeStringSchema,
  stringEnum,
  errorPayloadFields,
} from "#transport";
import { agentId } from "./ids.js";
import { userId } from "#identity/users";

const dateTimeString = dateTimeStringSchema();

/** Reports agent not found failures. */
export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFound",
  errorPayloadFields,
) {
  static readonly message = "Agent not found";
}

const agentMetadataSchema = Schema.Struct({
  purpose: Schema.optional(Schema.Array(Schema.String)),
  description: Schema.optional(Schema.String),
  tags: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});

const agentSchema = Schema.Struct({
  id: agentId,
  ownerUserId: Schema.optional(userId),
  name: Schema.String.pipe(
    Schema.minLength(3),
    Schema.maxLength(32),
    Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
  ),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  agentType: Schema.optional(stringEnum(["OpenClaw", "NanoClaw"])),
  metadata: Schema.optional(agentMetadataSchema),
  status: stringEnum(["active", "suspended"]),
  createdAt: dateTimeString,
});

/** Validates and decodes agent card values. */
export const agentCardSchema = agentSchema.omit("createdAt");

const agentOwnershipSchemaValue = Schema.Struct({
  agentId: agentId,
  ownerUserId: userId,
});

/** Represents agent values. */
export type Agent = Schema.Schema.Type<typeof agentSchema>;
/** Represents agent card values. */
export type AgentCard = Schema.Schema.Type<typeof agentCardSchema>;

/** Provides the validate agent runtime value. */
export const validateAgent = closedStructGuard(agentSchema);
/** Provides the validate agent card runtime value. */
export const validateAgentCard = closedStructGuard(agentCardSchema);

/**
 * Executes the agent ownership schema operation.
 * @returns The agent ownership schema result.
 */
export function agentOwnershipSchema(): typeof agentOwnershipSchemaValue {
  return agentOwnershipSchemaValue;
}
