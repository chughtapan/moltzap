/** @file Canonical branded identity identifiers and their exact encodings. */

import { Array, Either, Encoding, Schema } from "effect";

// safer-arch-ignore shared-kernel-cohesion: Canonical identity identifiers, their shared base64url decoder, and decoded AgentId ordering have one representation owner; artifact and Registry consumers use different subsets.

const IDENTIFIER_BYTE_LENGTH = 16;

/** Returns bytes only for their unique unpadded base64url spelling. */
export const decodeCanonicalBase64Url = (
  value: string,
): Uint8Array | undefined => {
  return Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => undefined,
    onRight: (decoded) =>
      Encoding.encodeBase64Url(decoded) === value ? decoded : undefined,
  });
};

/**
 * Tests whether a string is the unique base64url encoding of a fixed byte length.
 *
 * @param value Candidate unpadded base64url text.
 * @param byteLength Required decoded byte length.
 * @returns Whether the candidate has the one canonical encoding for that length.
 */
export const hasCanonicalBase64UrlLength = (
  value: string,
  byteLength: number,
): boolean => decodeCanonicalBase64Url(value)?.byteLength === byteLength;

/**
 * Constructs one exact prefixed identity Schema for its semantic owner.
 * The pattern preserves byte length and zero padding bits in runtime
 * validation and JSON Schema projections.
 *
 * @param name Nominal Schema and brand name.
 * @param prefix Fixed representation prefix.
 * @param byteLength Required decoded payload length.
 * @returns The exact branded string Schema.
 */
export const canonicalIdentifier = <const Name extends string>(
  name: Name,
  prefix: string,
  byteLength: number,
) => {
  const wholeCharacters = Math.floor((byteLength * 8) / 6);
  const remainingBits = (byteLength * 8) % 6;
  const finalCharacter =
    remainingBits === 0
      ? ""
      : `[${Array.makeBy(2 ** remainingBits, (value) =>
          Encoding.encodeBase64Url(
            Uint8Array.of(value << (8 - remainingBits)),
          ).charAt(0),
        ).join("")}]`;
  const pattern = new RegExp(
    `^${prefix}[A-Za-z0-9_-]{${wholeCharacters}}${finalCharacter}$`,
    "u",
  );
  return Schema.String.pipe(
    Schema.length(prefix.length + Math.ceil((byteLength * 8) / 6)),
    Schema.pattern(pattern),
    Schema.brand(name),
    Schema.annotations({
      identifier: name,
      description: `${name} canonical representation`,
    }),
  );
};

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare --
 * Named Effect Schemas share their domain names with the nominal types they decode.
 */

/** Canonical network identity minted by the Registry. */
export const AgentId = canonicalIdentifier(
  "AgentId",
  "agt_",
  IDENTIFIER_BYTE_LENGTH,
);
/** Validated nominal value decoded by {@link AgentId}. */
export type AgentId = typeof AgentId.Type;

/** Opaque identity of the principal represented by an agent. */
export const PrincipalId = canonicalIdentifier(
  "PrincipalId",
  "prn_",
  IDENTIFIER_BYTE_LENGTH,
);
/** Validated nominal value decoded by {@link PrincipalId}. */
export type PrincipalId = typeof PrincipalId.Type;

/** Immutable Registry-wide human-facing agent handle. */
export const AgentName = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(32),
  Schema.pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  Schema.brand("AgentName"),
  Schema.annotations({
    identifier: "AgentName",
    description: "Registry-wide immutable agent handle",
  }),
);
/** Validated nominal value decoded by {@link AgentName}. */
export type AgentName = typeof AgentName.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare --
 * Restore the general naming rules after the public Schema/type pairs.
 */

/**
 * Orders AgentIds by their decoded bytes, unsigned and bytewise. This is the
 * one decoded-AgentId order for recipient lists and Registry list pages.
 */
export const compareAgentIds = (left: AgentId, right: AgentId): number => {
  const leftBytes = decodeCanonicalBase64Url(left.slice(4));
  const rightBytes = decodeCanonicalBase64Url(right.slice(4));
  if (leftBytes === undefined || rightBytes === undefined) {
    return 0;
  }
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) {
      return 0;
    }
    const difference = leftByte - rightByte;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.byteLength - rightBytes.byteLength;
};
