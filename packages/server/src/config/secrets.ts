import { Schema, type Brand, type Redacted } from "effect";

type RegistrationSecretValue = string & Brand.Brand<"RegistrationSecret">;
const registrationSecretValueSchema: Schema.Schema<
  RegistrationSecretValue,
  string
> = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("RegistrationSecret"),
  Schema.annotations({ description: "Registration invite secret" }),
);

/** Represents registration secret values. */
export type RegistrationSecret = Redacted.Redacted<RegistrationSecretValue>;
/** Validates and decodes registration secret values. */
export const registrationSecret: Schema.Schema<RegistrationSecret, string> =
  Schema.Redacted(registrationSecretValueSchema);
