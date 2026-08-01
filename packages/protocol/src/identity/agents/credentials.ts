import { type Brand, type Redacted, Schema } from "effect";

const AGENT_KEY_PREFIX = "moltzap_agent_";
const KEY_ID_HEX_CHARS = 16;
const SECRET_HEX_CHARS = 48;
const KEY_ID_HEX_PATTERN = `[0-9a-f]{${KEY_ID_HEX_CHARS}}`;
const SECRET_HEX_PATTERN = `[0-9a-f]{${SECRET_HEX_CHARS}}`;

type AgentKeyValue = string & Brand.Brand<"AgentKey">;
const AgentKeyValue: Schema.Schema<AgentKeyValue, string> = Schema.String.pipe(
  Schema.pattern(
    new RegExp(
      `^${AGENT_KEY_PREFIX}${KEY_ID_HEX_PATTERN}_${SECRET_HEX_PATTERN}$`,
    ),
  ),
  Schema.brand("AgentKey"),
  Schema.annotations({ description: "MoltZap agent API key" }),
);

export type AgentKey = Redacted.Redacted<AgentKeyValue>;
export const AgentKey: Schema.Schema<AgentKey, string> =
  Schema.Redacted(AgentKeyValue);
