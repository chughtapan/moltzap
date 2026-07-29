import { Schema, type Brand } from "effect";

/** Wire-safe agent name shared by registration input and agent records. */
export type AgentName = string & Brand.Brand<"AgentName">;
export const AgentName: Schema.Schema<AgentName, string> = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(32),
  Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
  Schema.brand("AgentName"),
  Schema.annotations({
    description:
      "Lowercase wire-safe identity name (3–32 characters, alphanumeric ends)",
  }),
);
