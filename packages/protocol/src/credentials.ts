import { Schema } from "effect";
import { brandedString, type BrandedString } from "./transport/wire-string.js";

const AGENT_KEY_PREFIX = "moltzap_agent_";
const APP_KEY_PREFIX = "moltzap_app_";

const KEY_ID_HEX_CHARS = 16;
const SECRET_HEX_CHARS = 48;
const SERVER_MASTER_SECRET_BASE64_CHARS = 44;
const KEY_ID_HEX_PATTERN = `[0-9a-f]{${KEY_ID_HEX_CHARS}}`;
const SECRET_HEX_PATTERN = `[0-9a-f]{${SECRET_HEX_CHARS}}`;
const SERVER_MASTER_SECRET_BASE64_PATTERN = `[A-Za-z0-9+/]{43}=`;

const AgentKeyValue = brandedString("AgentKey", {
  pattern: `^${AGENT_KEY_PREFIX}${KEY_ID_HEX_PATTERN}_${SECRET_HEX_PATTERN}$`,
  description: "MoltZap agent API key",
});
type AgentKeyValue = BrandedString<"AgentKey">;

const AppKeyValue = brandedString("AppKey", {
  pattern: `^${APP_KEY_PREFIX}${KEY_ID_HEX_PATTERN}_${SECRET_HEX_PATTERN}$`,
  description: "MoltZap app API key",
});
type AppKeyValue = BrandedString<"AppKey">;

export const AgentKey = Schema.Redacted(AgentKeyValue);
export type AgentKey = Schema.Schema.Type<typeof AgentKey>;

export const AppKey = Schema.Redacted(AppKeyValue);
export type AppKey = Schema.Schema.Type<typeof AppKey>;

const InviteCodeValue = brandedString("InviteCode", {
  minLength: 1,
  description: "Registration invite code",
});
type InviteCodeValue = BrandedString<"InviteCode">;

export const InviteCode = Schema.Redacted(InviteCodeValue);
export type InviteCode = Schema.Schema.Type<typeof InviteCode>;

const RegistrationSecretValue = brandedString("RegistrationSecret", {
  minLength: 1,
  description: "Registration invite secret",
});
type RegistrationSecretValue = BrandedString<"RegistrationSecret">;

const ServerEncryptionMasterSecretValue = brandedString(
  "ServerEncryptionMasterSecret",
  {
    minLength: SERVER_MASTER_SECRET_BASE64_CHARS,
    pattern: `^${SERVER_MASTER_SECRET_BASE64_PATTERN}$`,
    description: "32-byte base64 server encryption master secret",
  },
);
type ServerEncryptionMasterSecretValue =
  BrandedString<"ServerEncryptionMasterSecret">;

export const RegistrationSecret = Schema.Redacted(RegistrationSecretValue);
export type RegistrationSecret = Schema.Schema.Type<typeof RegistrationSecret>;

export const ServerEncryptionMasterSecret = Schema.Redacted(
  ServerEncryptionMasterSecretValue,
);
export type ServerEncryptionMasterSecret = Schema.Schema.Type<
  typeof ServerEncryptionMasterSecret
>;
