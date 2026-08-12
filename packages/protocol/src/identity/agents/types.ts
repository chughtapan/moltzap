import { Schema } from "effect";

import { stringEnum, errorPayloadFields } from "#transport";
import { agentId } from "./ids.js";
import { agentName } from "./name.js";
import { userId } from "#identity/users";

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

/** Validates and decodes agent card values. */
export const agentCardSchema = Schema.Struct({
  id: agentId,
  ownerUserId: Schema.optional(userId),
  name: agentName,
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  agentType: Schema.optional(stringEnum(["OpenClaw", "NanoClaw"])),
  metadata: Schema.optional(agentMetadataSchema),
  status: stringEnum(["active", "suspended"]),
});

/** Represents agent card values. */
export type AgentCard = Schema.Schema.Type<typeof agentCardSchema>;
