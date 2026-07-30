import { Schema, type Brand } from "effect";

import { formatString } from "#transport";

/** Represents agent id values. */
export type AgentId = string & Brand.Brand<"AgentId">;
/** Validates and decodes agent id values. */
export const agentId: Schema.Schema<AgentId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("AgentId"),
  Schema.annotations({ description: "Branded AgentId" }),
);
