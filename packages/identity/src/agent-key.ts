/** @file Exact Ed25519 public keys and opaque private signing authority. */

import { ed25519 } from "@noble/curves/ed25519.js";
import { Data, Effect, Either, Encoding, Redacted, Schema } from "effect";
import {
  calculateJwkThumbprintUri,
  type CryptoKey,
  exportJWK,
  importJWK,
  importPKCS8,
  type JWK,
} from "jose";

const PUBLIC_KEY_BYTE_LENGTH = 32;
const SIGNATURE_BYTE_LENGTH = 64;

const FIELD_MODULUS = Uint8Array.from([
  0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
]);

const SCALAR_ORDER = Uint8Array.from([
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde,
  0xf9, 0xde, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
]);

const bytesFromHex = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value, "hex"));

const SMALL_ORDER_POINTS = Object.freeze([
  bytesFromHex("00".repeat(32)),
  bytesFromHex(`01${"00".repeat(31)}`),
  bytesFromHex(
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  ),
  bytesFromHex(
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  ),
  bytesFromHex(`ec${"ff".repeat(30)}7f`),
  bytesFromHex(`ed${"ff".repeat(30)}7f`),
  bytesFromHex(`ee${"ff".repeat(30)}7f`),
]);

const isLessThanLittleEndian = (
  value: Uint8Array,
  upperBound: Uint8Array,
): boolean => {
  if (value.byteLength !== upperBound.byteLength) {
    return false;
  }
  for (let index = value.byteLength - 1; index >= 0; index -= 1) {
    const valueByte = value[index];
    const boundByte = upperBound[index];
    if (valueByte === undefined || boundByte === undefined) {
      return false;
    }
    if (valueByte !== boundByte) {
      return valueByte < boundByte;
    }
  }
  return false;
};

const hasCanonicalPointEncoding = (value: Uint8Array): boolean => {
  if (value.byteLength !== PUBLIC_KEY_BYTE_LENGTH) {
    return false;
  }
  const coordinate = Uint8Array.from(value);
  const finalByte = coordinate[PUBLIC_KEY_BYTE_LENGTH - 1];
  if (finalByte === undefined) {
    return false;
  }
  coordinate[PUBLIC_KEY_BYTE_LENGTH - 1] = finalByte & 0x7f;
  return isLessThanLittleEndian(coordinate, FIELD_MODULUS);
};

const encodesSmallOrderPoint = (value: Uint8Array): boolean =>
  SMALL_ORDER_POINTS.some((point) => {
    for (let index = 0; index < PUBLIC_KEY_BYTE_LENGTH; index += 1) {
      const valueByte = value[index];
      const pointByte = point[index];
      if (valueByte === undefined || pointByte === undefined) {
        return false;
      }
      const mask = index === PUBLIC_KEY_BYTE_LENGTH - 1 ? 0x7f : 0xff;
      if ((valueByte & mask) !== pointByte) {
        return false;
      }
    }
    return true;
  });

const hasAcceptedPublicKeyEncoding = (value: Uint8Array): boolean =>
  hasCanonicalPointEncoding(value) && !encodesSmallOrderPoint(value);

const decodeAcceptedPublicKey = (value: string): Uint8Array | undefined =>
  Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => undefined,
    onRight: (bytes) =>
      Encoding.encodeBase64Url(bytes) === value &&
      hasAcceptedPublicKeyEncoding(bytes)
        ? bytes
        : undefined,
  });

/**
 * Checks the closed Ed25519 signature representation before cryptographic
 * verification.
 *
 * The standards verifier supplies the strict verification equation. This
 * boundary additionally rejects alternate point and scalar encodings that
 * permissive platform verifiers may otherwise accept. The public-key Schema
 * separately rejects small-order verification keys.
 *
 * @param signature Candidate 64-byte Ed25519 signature.
 * @returns Whether its point and scalar use the single accepted encoding.
 */
export const hasCanonicalEd25519SignatureEncoding = (
  signature: Uint8Array,
): boolean => {
  if (signature.byteLength !== SIGNATURE_BYTE_LENGTH) {
    return false;
  }
  const encodedPoint = signature.subarray(0, PUBLIC_KEY_BYTE_LENGTH);
  const scalar = signature.subarray(PUBLIC_KEY_BYTE_LENGTH);
  return (
    hasCanonicalPointEncoding(encodedPoint) &&
    isLessThanLittleEndian(scalar, SCALAR_ORDER)
  );
};

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
    // eslint-disable-next-line agent-code-guard/bare-catch -- A Schema predicate converts hostile reflection into ordinary validation failure. #ignore-sloppy-code-next-line[bare-catch]: The predicate returns false.
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
    Schema.filter((value) => decodeAcceptedPublicKey(value) !== undefined, {
      identifier: "Ed25519PublicKeyCoordinate",
      description: "Canonical non-small-order Ed25519 public-key coordinate",
    }),
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

/**
 * Reports failure to derive the standard thumbprint URI or the X25519 key for
 * a validated key.
 */
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

/** JWE key management that consumes the opening key in sealed bodies. */
const OPENING_KEY_ALGORITHM = "ECDH-ES+A256KW";

/** X25519 public JWK of one agent: the key a sealed body is encrypted to. */
export interface X25519PublicJwk {
  readonly crv: "X25519";
  readonly kty: "OKP";
  readonly x: string;
}

/**
 * Maps a validated Ed25519 public key to the same agent's X25519 public key
 * through the RFC 7748 birational map `u = (1 + y) / (1 - y)`. The opening key
 * that `fromPkcs8` derives is the private half of this key.
 *
 * The Ed25519 public-key Schema admits canonical encodings that are not curve
 * points, and the map fails for those.
 *
 * @param publicKey Validated Ed25519 public key, such as an AgentCard key.
 * @returns The X25519 public JWK.
 */
export const x25519PublicJwk = (
  publicKey: Ed25519PublicKey,
): Either.Either<X25519PublicJwk, Ed25519PublicKeyOperationError> =>
  Either.try({
    try: (): X25519PublicJwk => ({
      crv: "X25519",
      kty: "OKP",
      x: Encoding.encodeBase64Url(
        ed25519.utils.toMontgomery(
          Encoding.decodeBase64Url(publicKey.x).pipe(Either.getOrThrow),
        ),
      ),
    }),
    catch: () => new Ed25519PublicKeyOperationError(),
  });

declare const agentSigningAuthorityBrand: unique symbol;

/**
 * Opaque authority over one imported Ed25519 private key and the X25519
 * opening key derived from it.
 */
export interface AgentSigningAuthority {
  readonly [agentSigningAuthorityBrand]: "AgentSigningAuthority";
}

/** The supplied private-key material cannot act as an Ed25519 signer. */
export class InvalidAgentPrivateKeyError extends Data.TaggedError(
  "InvalidAgentPrivateKeyError",
) {}

type AuthorityState = Readonly<{
  privateKey: CryptoKey;
  openingKey: CryptoKey;
  publicKey: Ed25519PublicKey;
}>;

const authorityState = new WeakMap<AgentSigningAuthority, AuthorityState>();

const getAuthorityState = (
  authority: AgentSigningAuthority,
): AuthorityState => {
  const state = authorityState.get(authority);
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The construction invariant inserts state before this opaque value escapes.
  return state!;
};

const invalidPrivateKey = (): InvalidAgentPrivateKeyError =>
  new InvalidAgentPrivateKeyError();

/**
 * Derives the non-extractable X25519 opening key from the Ed25519 seed.
 *
 * The secret is the clamped first half of SHA-512 over the seed, which is the
 * RFC 8032 signing scalar. The JWK pairs it with `x25519PublicJwk` of the
 * Ed25519 public key, and the import refuses a pair whose halves disagree, so
 * the opener and every sealer use the same key.
 *
 * @param exportedKey Private JWK exported from the PKCS#8 key.
 * @param publicKey Ed25519 public key of the same seed.
 * @returns The opening key, usable only for X25519 `deriveBits`.
 */
const importOpeningKey = (
  exportedKey: JWK,
  publicKey: Ed25519PublicKey,
): Effect.Effect<CryptoKey, InvalidAgentPrivateKeyError> =>
  Effect.gen(function* () {
    if (exportedKey.d === undefined) {
      return yield* new InvalidAgentPrivateKeyError();
    }
    const seed = yield* Either.mapLeft(
      Encoding.decodeBase64Url(exportedKey.d),
      invalidPrivateKey,
    );
    const agreementPublicKey = yield* Either.mapLeft(
      x25519PublicJwk(publicKey),
      invalidPrivateKey,
    );
    const secret = yield* Effect.try({
      try: () => ed25519.utils.toMontgomerySecret(seed),
      catch: invalidPrivateKey,
    });
    const openingKey = yield* Effect.tryPromise({
      try: () =>
        importJWK(
          { ...agreementPublicKey, d: Encoding.encodeBase64Url(secret) },
          OPENING_KEY_ALGORITHM,
          { extractable: false },
        ),
      catch: invalidPrivateKey,
    });
    if (openingKey instanceof Uint8Array) {
      return yield* new InvalidAgentPrivateKeyError();
    }
    return openingKey;
  });

/**
 * Imports one Ed25519 PKCS#8 key as an opaque authority.
 *
 * JOSE needs an extractable import to derive the public JWK and the seed of
 * the opening key, while the authority retains a separate non-extractable
 * import for signing.
 *
 * @param pkcs8 Redacted unencrypted Ed25519 PKCS#8 text.
 * @returns The authority.
 */
const fromPkcs8 = (
  pkcs8: Redacted.Redacted,
): Effect.Effect<AgentSigningAuthority, InvalidAgentPrivateKeyError> =>
  Effect.gen(function* () {
    const extractableKey = yield* Effect.tryPromise({
      try: () =>
        importPKCS8(Redacted.value(pkcs8), "Ed25519", {
          extractable: true,
        }),
      catch: invalidPrivateKey,
    });
    const exportedKey = yield* Effect.tryPromise({
      try: () => exportJWK(extractableKey),
      catch: invalidPrivateKey,
    });
    const publicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
      {
        crv: exportedKey.crv,
        kty: exportedKey.kty,
        x: exportedKey.x,
      },
      {
        exact: true,
        onExcessProperty: "error",
      },
    ).pipe(Effect.mapError(invalidPrivateKey));
    const openingKey = yield* importOpeningKey(exportedKey, publicKey);

    const privateKey = yield* Effect.tryPromise({
      try: () =>
        importPKCS8(Redacted.value(pkcs8), "Ed25519", {
          extractable: false,
        }),
      catch: invalidPrivateKey,
    });
    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- This assertion is safe because this module alone constructs values after inserting their WeakMap state.
    const authority = Object.freeze({}) as AgentSigningAuthority;
    authorityState.set(authority, { privateKey, openingKey, publicKey });
    return authority;
  });

const publicKey = (authority: AgentSigningAuthority): Ed25519PublicKey =>
  getAuthorityState(authority).publicKey;

/**
 * Returns the non-extractable key to identity-owned signed-artifact modules.
 *
 * @param authority Authority whose private key is needed.
 * @returns The authority's non-extractable private key.
 */
export const agentSigningPrivateKey = (
  authority: AgentSigningAuthority,
): CryptoKey => getAuthorityState(authority).privateKey;

/**
 * Returns the non-extractable X25519 key to the identity-owned sealed-body
 * module.
 *
 * @param authority Authority whose opening key is needed.
 * @returns The authority's non-extractable X25519 opening key.
 */
export const agentOpeningPrivateKey = (
  authority: AgentSigningAuthority,
): CryptoKey => getAuthorityState(authority).openingKey;

/**
 * Loads and identifies one Ed25519 signing authority without exposing its
 * private keys or a generic signing or decryption operation.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The approved Effect-style API uses one name for its opaque type and capability value.
export const AgentSigningAuthority = Object.freeze({
  fromPkcs8,
  publicKey,
});
