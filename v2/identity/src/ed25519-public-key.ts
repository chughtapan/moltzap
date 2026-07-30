import { calculateJwkThumbprintUri } from "jose";
import { Data, Effect, Schema } from "effect";
import { hasCanonicalBase64UrlLength } from "./identity-values.js";

const PUBLIC_KEY_BYTE_LENGTH = 32;

type PublicKeyValue = Readonly<{
  crv: "Ed25519";
  kty: "OKP";
  x: string;
}>;

const missingMember = Symbol("missingMember");

const hasExactPublicKeyNames = (value: object): boolean => {
  const keys = Reflect.ownKeys(value);
  const names = new Set(keys);
  return (
    keys.length === 3 && names.has("crv") && names.has("kty") && names.has("x")
  );
};

const readPublicKeyMember = (
  value: object,
  name: "crv" | "kty" | "x",
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor)
  ) {
    return missingMember;
  }
  return descriptor.value;
};

const hasPublicKeyMembers = (value: object): value is PublicKeyValue => {
  if (!hasExactPublicKeyNames(value)) {
    return false;
  }
  const crv = readPublicKeyMember(value, "crv");
  const kty = readPublicKeyMember(value, "kty");
  const x = readPublicKeyMember(value, "x");
  return crv === "Ed25519" && kty === "OKP" && typeof x === "string";
};

const isFrozenPublicKey = (value: unknown): value is PublicKeyValue => {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.isFrozen(value) &&
      hasPublicKeyMembers(value)
    );
    // eslint-disable-next-line agent-code-guard/bare-catch -- A Schema predicate converts hostile reflection into ordinary validation failure.
  } catch {
    return false;
  }
};

const publicKeyValueSchema = Schema.declare(isFrozenPublicKey, {
  identifier: "Ed25519PublicKeyValue",
});

const publicKeyRepresentation = Schema.Struct({
  crv: Schema.Literal("Ed25519"),
  kty: Schema.Literal("OKP"),
  x: Schema.String.pipe(
    Schema.filter(
      (value) => hasCanonicalBase64UrlLength(value, PUBLIC_KEY_BYTE_LENGTH),
      {
        identifier: "Ed25519PublicKeyCoordinate",
        description: "Canonical Ed25519 public-key coordinate",
      },
    ),
  ),
}).annotations({
  identifier: "Ed25519PublicKeyRepresentation",
  parseOptions: {
    exact: true,
    onExcessProperty: "error",
  },
});

/** Exact immutable Ed25519 public JWK. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas use the public model's type name so callers import one vocabulary term.
export const Ed25519PublicKey = Schema.transform(
  publicKeyRepresentation,
  publicKeyValueSchema,
  {
    strict: true,
    decode: (value) =>
      Object.freeze({
        crv: value.crv,
        kty: value.kty,
        x: value.x,
      }),
    encode: (value) => ({
      crv: value.crv,
      kty: value.kty,
      x: value.x,
    }),
  },
).pipe(
  Schema.brand("Ed25519PublicKey"),
  Schema.annotations({
    identifier: "Ed25519PublicKey",
    description: "Exact immutable Ed25519 public JWK",
    parseOptions: {
      exact: true,
      onExcessProperty: "error",
    },
  }),
);

/** Validated immutable Ed25519 public JWK. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- Effect's same-named Schema and inferred type form one public boundary model.
export type Ed25519PublicKey = typeof Ed25519PublicKey.Type;

/** Reports failure to derive the standard thumbprint URI for a validated key. */
export class Ed25519PublicKeyOperationError extends Data.TaggedError(
  "Ed25519PublicKeyOperationError",
) {}

/**
 * Derives the RFC JWK thumbprint URI for a validated Ed25519 public key.
 *
 * @param publicKey Validated public key.
 * @returns The standard SHA-256 JWK thumbprint URI.
 * @failure Ed25519PublicKeyOperationError when the JOSE implementation cannot
 * derive the URI.
 */
export const ed25519PublicKeyThumbprintUri = (
  publicKey: Ed25519PublicKey,
): Effect.Effect<string, Ed25519PublicKeyOperationError> =>
  Effect.tryPromise({
    try: () =>
      calculateJwkThumbprintUri(
        {
          crv: publicKey.crv,
          kty: publicKey.kty,
          x: publicKey.x,
        },
        "sha256",
      ),
    catch: () => new Ed25519PublicKeyOperationError(),
  });
