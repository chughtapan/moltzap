import { Schema, type Brand, type Redacted } from "effect";

const AGENT_KEY_PREFIX = "moltzap_agent_";
const KEY_ID_HEX_CHARS = 16;
const SECRET_HEX_CHARS = 48;
const KEY_ID_HEX_PATTERN = `[0-9a-f]{${KEY_ID_HEX_CHARS}}`;
const SECRET_HEX_PATTERN = `[0-9a-f]{${SECRET_HEX_CHARS}}`;

type AgentKeyValue = string & Brand.Brand<"AgentKey">;
const agentKeyValue: Schema.Schema<AgentKeyValue, string> = Schema.String.pipe(
  Schema.pattern(
    new RegExp(
      `^${AGENT_KEY_PREFIX}${KEY_ID_HEX_PATTERN}_${SECRET_HEX_PATTERN}$`,
    ),
  ),
  Schema.brand("AgentKey"),
  Schema.annotations({ description: "MoltZap agent API key" }),
);

/** Represents agent key values. */
export type AgentKey = Redacted.Redacted<AgentKeyValue>;
/** Validates and decodes agent key values. */
export const agentKey: Schema.Schema<AgentKey, string> =
  Schema.Redacted(agentKeyValue);
