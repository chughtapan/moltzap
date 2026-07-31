import { Either, Encoding, Schema } from "effect";

const INSTANCE_BYTE_LENGTH = 16;
const DIGEST_BYTE_LENGTH = 32;
const MAXIMUM_CURSOR_LENGTH = 348;

const hasCanonicalBase64UrlLength = (
  value: string,
  byteLength: number,
): boolean =>
  Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => false,
    onRight: (decoded) =>
      decoded.byteLength === byteLength &&
      Encoding.encodeBase64Url(decoded) === value,
  });

const canonicalValue = <const Name extends string>(
  name: Name,
  prefix: string,
  byteLength: number,
) =>
  Schema.String.pipe(
    Schema.filter(
      (value) => {
        const text = value;
        const expectedPrefix = prefix;
        return (
          text.startsWith(expectedPrefix) &&
          hasCanonicalBase64UrlLength(
            text.slice(expectedPrefix.length),
            byteLength,
          )
        );
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

const protectedHeader = new TextEncoder().encode(
  '{"alg":"dir","enc":"A256GCM","typ":"application/vnd.moltzap.poll-cursor+jwe"}',
);

interface CursorSegments {
  readonly encodedHeader: string;
  readonly encryptedKey: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

const segmentAt = (segments: readonly string[], index: number): string =>
  segments[index] ?? "";

const extractCursorSegments = (value: string): CursorSegments | undefined => {
  const text = value;
  let result: CursorSegments | undefined;
  // eslint-disable-next-line sonarjs/null-dereference -- callers and the Schema refinement require a string
  if (!text.startsWith("plc_") || text.length > MAXIMUM_CURSOR_LENGTH) {
    result = undefined;
  } else {
    const segments = text.slice(4).split(".");
    if (segments.length === 5) {
      result = {
        encodedHeader: segmentAt(segments, 0),
        encryptedKey: segmentAt(segments, 1),
        iv: segmentAt(segments, 2),
        ciphertext: segmentAt(segments, 3),
        tag: segmentAt(segments, 4),
      };
    }
  }
  return result;
};

const hasCanonicalCiphertext = (ciphertext: string): boolean =>
  Either.match(Encoding.decodeBase64Url(ciphertext), {
    onLeft: () => false,
    onRight: (decoded) =>
      decoded.byteLength > 0 &&
      Encoding.encodeBase64Url(decoded) === ciphertext,
  });

const hasCanonicalCursorShape = (value: string): boolean => {
  const segments = extractCursorSegments(value);
  if (segments === undefined || segments.encryptedKey !== "") {
    return false;
  }
  if (
    segments.encodedHeader !== Encoding.encodeBase64Url(protectedHeader) ||
    !hasCanonicalBase64UrlLength(segments.iv, 12)
  ) {
    return false;
  }
  return (
    hasCanonicalBase64UrlLength(segments.tag, 16) &&
    hasCanonicalCiphertext(segments.ciphertext)
  );
};

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare --
 * Named Effect Schemas share their domain names with the nominal types they decode.
 */

/** Identifies one volatile Router process instance. */
export const RouterInstanceId = canonicalValue(
  "RouterInstanceId",
  "rti_",
  INSTANCE_BYTE_LENGTH,
);
/** Validated Router process identity. */
export type RouterInstanceId = typeof RouterInstanceId.Type;

/** Equality receipt for one complete retained SignedMessage. */
export const SignedMessageDigest = canonicalValue(
  "SignedMessageDigest",
  "smd_",
  DIGEST_BYTE_LENGTH,
);
/** Validated SignedMessage equality receipt. */
export type SignedMessageDigest = typeof SignedMessageDigest.Type;

/** Opaque, authenticated continuation for one caller and Router instance. */
export const PollCursor = Schema.String.pipe(
  Schema.filter(hasCanonicalCursorShape, {
    identifier: "PollCursor",
    description: "Canonical opaque Router poll continuation",
  }),
  Schema.brand("PollCursor"),
  Schema.annotations({
    identifier: "PollCursor",
    description: "Canonical opaque Router poll continuation",
  }),
);
/** Validated opaque Router poll continuation. */
export type PollCursor = typeof PollCursor.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- restore the shared project rules */

/** Maximum ASCII characters in a valid PollCursor. */
export const maximumPollCursorLength = MAXIMUM_CURSOR_LENGTH;
