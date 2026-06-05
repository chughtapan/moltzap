import { Schema, type Brand, type Redacted } from "effect";

const AGENT_KEY_PREFIX = "moltzap_agent_";
const APP_KEY_PREFIX = "moltzap_app_";

const KEY_ID_HEX_CHARS = 16;
const SECRET_HEX_CHARS = 48;
const SERVER_MASTER_SECRET_BASE64_CHARS = 44;
const KEY_ID_HEX_PATTERN = `[0-9a-f]{${KEY_ID_HEX_CHARS}}`;
const SECRET_HEX_PATTERN = `[0-9a-f]{${SECRET_HEX_CHARS}}`;
const SERVER_MASTER_SECRET_BASE64_PATTERN = `[A-Za-z0-9+/]{43}=`;

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

type AppKeyValue = string & Brand.Brand<"AppKey">;
const AppKeyValue: Schema.Schema<AppKeyValue, string> = Schema.String.pipe(
  Schema.pattern(
    new RegExp(
      `^${APP_KEY_PREFIX}${KEY_ID_HEX_PATTERN}_${SECRET_HEX_PATTERN}$`,
    ),
  ),
  Schema.brand("AppKey"),
  Schema.annotations({ description: "MoltZap app API key" }),
);

export type AgentKey = Redacted.Redacted<AgentKeyValue>;
export const AgentKey: Schema.Schema<AgentKey, string> =
  Schema.Redacted(AgentKeyValue);

export type AppKey = Redacted.Redacted<AppKeyValue>;
export const AppKey: Schema.Schema<AppKey, string> =
  Schema.Redacted(AppKeyValue);

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

type RegistrationSecretValue = string & Brand.Brand<"RegistrationSecret">;
const RegistrationSecretValue: Schema.Schema<RegistrationSecretValue, string> =
  Schema.String.pipe(
    Schema.minLength(1),
    Schema.brand("RegistrationSecret"),
    Schema.annotations({ description: "Registration invite secret" }),
  );

type ServerEncryptionMasterSecretValue = string &
  Brand.Brand<"ServerEncryptionMasterSecret">;
const ServerEncryptionMasterSecretValue: Schema.Schema<
  ServerEncryptionMasterSecretValue,
  string
> = Schema.String.pipe(
  Schema.minLength(SERVER_MASTER_SECRET_BASE64_CHARS),
  Schema.pattern(new RegExp(`^${SERVER_MASTER_SECRET_BASE64_PATTERN}$`)),
  Schema.brand("ServerEncryptionMasterSecret"),
  Schema.annotations({
    description: "32-byte base64 server encryption master secret",
  }),
);

export type RegistrationSecret = Redacted.Redacted<RegistrationSecretValue>;
export const RegistrationSecret: Schema.Schema<RegistrationSecret, string> =
  Schema.Redacted(RegistrationSecretValue);

export type ServerEncryptionMasterSecret =
  Redacted.Redacted<ServerEncryptionMasterSecretValue>;
export const ServerEncryptionMasterSecret: Schema.Schema<
  ServerEncryptionMasterSecret,
  string
> = Schema.Redacted(ServerEncryptionMasterSecretValue);
