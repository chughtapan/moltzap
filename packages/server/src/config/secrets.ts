import { Schema, type Brand, type Redacted } from "effect";

const SERVER_MASTER_SECRET_BASE64_CHARS = 44;
const SERVER_MASTER_SECRET_BASE64_PATTERN = `[A-Za-z0-9+/]{43}=`;

type RegistrationSecretValue = string & Brand.Brand<"RegistrationSecret">;
const registrationSecretValueSchema: Schema.Schema<
  RegistrationSecretValue,
  string
> = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("RegistrationSecret"),
  Schema.annotations({ description: "Registration invite secret" }),
);

type ServerEncryptionMasterSecretValue = string &
  Brand.Brand<"ServerEncryptionMasterSecret">;
const serverEncryptionMasterSecretValueSchema: Schema.Schema<
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

/** Represents registration secret values. */
export type RegistrationSecret = Redacted.Redacted<RegistrationSecretValue>;
/** Validates and decodes registration secret values. */
export const registrationSecret: Schema.Schema<RegistrationSecret, string> =
  Schema.Redacted(registrationSecretValueSchema);

/** Represents server encryption master secret values. */
export type ServerEncryptionMasterSecret =
  Redacted.Redacted<ServerEncryptionMasterSecretValue>;
/** Validates and decodes server encryption master secret values. */
export const serverEncryptionMasterSecret: Schema.Schema<
  ServerEncryptionMasterSecret,
  string
> = Schema.Redacted(serverEncryptionMasterSecretValueSchema);
