/** @file Canonical branded identity identifiers and their exact encodings. */

import { Either, Encoding, Schema } from "effect";

const IDENTIFIER_BYTE_LENGTH = 16;

const decodeCanonicalBase64Url = (value: string): Uint8Array | undefined => {
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
) =>
  Schema.String.pipe(
    Schema.filter(
      (value) => {
        const hasPrefix = value.startsWith(prefix);
        if (!hasPrefix) {
          return false;
        }
        const payload = value.slice(prefix.length);
        return hasCanonicalBase64UrlLength(payload, byteLength);
      },
      {
        identifier: name,
        description: `${name} canonical representation`,
      },
    ),
    Schema.brand(name),
    Schema.annotations({
      identifier: name,
      description: `${name} canonical representation`,
    }),
  );

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
