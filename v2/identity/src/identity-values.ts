import { Either, Encoding, Schema } from "effect";

const IDENTIFIER_BYTE_LENGTH = 16;
const DIGEST_BYTE_LENGTH = 32;
const WHOLE_SECOND_UTC =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/;

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

const canonicalValue = <const Name extends string>(
  name: Name,
  prefix: string,
  byteLength: number,
) =>
  Schema.String.pipe(
    Schema.filter(
      (value) =>
        value.startsWith(prefix) &&
        hasCanonicalBase64UrlLength(value.slice(prefix.length), byteLength),
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

const isWholeSecondUtc = (value: string): boolean => {
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) {
    return false;
  }
  return (
    new Date(epochMilliseconds).toISOString() === `${value.slice(0, -1)}.000Z`
  );
};

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare --
 * Named Effect Schemas share their domain names with the nominal types they decode.
 */

/** Canonical network identity minted by the Registry. */
export const AgentId = canonicalValue(
  "AgentId",
  "agt_",
  IDENTIFIER_BYTE_LENGTH,
);
/** Validated nominal value decoded by {@link AgentId}. */
export type AgentId = typeof AgentId.Type;

/** Opaque identity of the principal represented by an agent. */
export const PrincipalId = canonicalValue(
  "PrincipalId",
  "prn_",
  IDENTIFIER_BYTE_LENGTH,
);
/** Validated nominal value decoded by {@link PrincipalId}. */
export type PrincipalId = typeof PrincipalId.Type;

/** Idempotency identity for a registration operation. */
export const OperationId = canonicalValue(
  "OperationId",
  "opn_",
  IDENTIFIER_BYTE_LENGTH,
);
/** Validated nominal value decoded by {@link OperationId}. */
export type OperationId = typeof OperationId.Type;

/** Sender-scoped identity of one attributed message. */
export const MessageId = canonicalValue(
  "MessageId",
  "msg_",
  IDENTIFIER_BYTE_LENGTH,
);
/** Validated nominal value decoded by {@link MessageId}. */
export type MessageId = typeof MessageId.Type;

/** Digest binding a message to one complete immutable AgentCard. */
export const AgentCardDigest = canonicalValue(
  "AgentCardDigest",
  "acd_",
  DIGEST_BYTE_LENGTH,
);
/** Validated nominal value decoded by {@link AgentCardDigest}. */
export type AgentCardDigest = typeof AgentCardDigest.Type;

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

/** Whole-second UTC issuance evidence carried by an AgentCard. */
export const AgentCardIssuedAt = Schema.String.pipe(
  Schema.pattern(WHOLE_SECOND_UTC),
  Schema.filter(isWholeSecondUtc, {
    identifier: "AgentCardIssuedAt",
    description: "AgentCard issuance time in whole-second UTC",
  }),
  Schema.brand("AgentCardIssuedAt"),
  Schema.annotations({
    identifier: "AgentCardIssuedAt",
    description: "AgentCard issuance time in whole-second UTC",
  }),
);
/** Validated nominal value decoded by {@link AgentCardIssuedAt}. */
export type AgentCardIssuedAt = typeof AgentCardIssuedAt.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare --
 * Restore the general naming rules after the public Schema/type pairs.
 */
