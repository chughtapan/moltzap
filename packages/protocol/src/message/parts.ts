import { Effect, Schema } from "effect";
import { closedStructGuard, formatString } from "#transport";

const TextPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32768)),
});

const ImagePartSchema = Schema.Struct({
  type: Schema.Literal("image"),
  url: formatString("uri").pipe(Schema.minLength(1)),
  altText: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
});

const FilePartSchema = Schema.Struct({
  type: Schema.Literal("file"),
  url: formatString("uri").pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  mimeType: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  ),
  size: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
});

const PartSchema = Schema.Union(
  TextPartSchema,
  ImagePartSchema,
  FilePartSchema,
);

/** User-authored message content part. */
export type Part = Schema.Schema.Type<typeof PartSchema>;

const MessagePartsSchema = Schema.NonEmptyArray(PartSchema).pipe(
  Schema.maxItems(10),
);
const MessagePartsTextSchema = Schema.parseJson(MessagePartsSchema);

/**
 * Return the canonical message-parts schema.
 *
 * Recording and other protocol-adjacent boundaries compose this schema
 * directly so persisted bodies cannot drift from the wire contract.
 */
export function messagePartsSchema(): typeof MessagePartsSchema {
  return MessagePartsSchema;
}

/** Nonempty protocol message content. */
export type MessageParts = Schema.Schema.Type<typeof MessagePartsSchema>;

const decodeMessagePartsEffect = Schema.decodeUnknown(MessagePartsSchema);
const decodeMessagePartsTextEffect = Schema.decodeUnknown(
  MessagePartsTextSchema,
);

/** Decode a message-parts payload and die on malformed persisted data. */
export function decodeMessageParts(
  value: unknown,
): Effect.Effect<MessageParts, never> {
  return decodeMessagePartsEffect(value, {
    onExcessProperty: "error",
  }).pipe(Effect.orDie);
}

/** Decode persisted plaintext message parts and die on malformed persisted data. */
export function decodeMessagePartsText(
  value: string,
): Effect.Effect<MessageParts, never> {
  return decodeMessagePartsTextEffect(value, {
    onExcessProperty: "error",
  }).pipe(Effect.orDie);
}

/** Return true when the value is a closed text part. */
export const validateTextPart = closedStructGuard(TextPartSchema);
