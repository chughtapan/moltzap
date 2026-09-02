/** @file Exact JCS encoding and byte-equality decoding for Client values. */

import canonicalize from "canonicalize";
import { Data, Effect, Schema } from "effect";

/* eslint-disable jsdoc/require-jsdoc -- This package-private codec is named and documented at its representation facade. */

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();
const exactOptions = {
  exact: true,
  onExcessProperty: "error" as const,
};

/** A Client-owned representation, hash, or verification check failed. */
export class ClientRepresentationError extends Data.TaggedError(
  "ClientRepresentationError",
) {}

export const representationFailure = (): ClientRepresentationError =>
  new ClientRepresentationError();

export const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
};

export const canonicalBytes = (
  value: unknown,
): Effect.Effect<Uint8Array, ClientRepresentationError> =>
  Effect.try({
    try: () => canonicalize(value),
    catch: representationFailure,
  }).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.fail(representationFailure())
        : Effect.succeed(utf8Encoder.encode(text)),
    ),
  );

/** Encode one closed value into its unique JCS UTF-8 representation. */
export const encodeCanonical = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  value: A,
): Effect.Effect<Uint8Array, ClientRepresentationError, R> =>
  Schema.encode(schema)(value).pipe(
    Effect.mapError(representationFailure),
    Effect.flatMap(canonicalBytes),
  );

/** Decode one closed value only when its input bytes are already exact JCS. */
export const decodeCanonical = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  bytes: Uint8Array,
): Effect.Effect<A, ClientRepresentationError, R> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => utf8Decoder.decode(bytes),
      catch: representationFailure,
    });
    const decoded = yield* Schema.decodeUnknown(Schema.parseJson(schema))(
      text,
      exactOptions,
    ).pipe(Effect.mapError(representationFailure));
    const canonical = yield* encodeCanonical(schema, decoded);
    if (!sameBytes(bytes, canonical)) {
      return yield* representationFailure();
    }
    return decoded;
  }).pipe(Effect.withSpan("decodeCanonical"));

/* eslint-enable jsdoc/require-jsdoc -- Restore package documentation rules. */
