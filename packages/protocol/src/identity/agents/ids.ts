import { type Brand, Schema } from "effect";

import { formatString } from "#transport";

export type AgentId = string & Brand.Brand<"AgentId">;
export const AgentId: Schema.Schema<AgentId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("AgentId"),
  Schema.annotations({ description: "Branded AgentId" }),
);
