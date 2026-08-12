import { Effect, Schema } from "effect";
import { formatString } from "#transport";

const textPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32768)),
});

const imagePartSchema = Schema.Struct({
  type: Schema.Literal("image"),
  url: formatString("uri").pipe(Schema.minLength(1)),
  altText: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
});

const filePartSchema = Schema.Struct({
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

const partSchema = Schema.Union(
  textPartSchema,
  imagePartSchema,
  filePartSchema,
);

/** User-authored message content part. */
export type Part = Schema.Schema.Type<typeof partSchema>;

const messagePartsSchemaValue = Schema.NonEmptyArray(partSchema).pipe(
  Schema.maxItems(10),
);

/**
 * Return the canonical message-parts schema.
 *
 * Recording and other protocol-adjacent boundaries compose this schema
 * directly so persisted bodies cannot drift from the wire contract.
 * @returns The nonempty schema shared by all message boundaries.
 */
export function messagePartsSchema(): typeof messagePartsSchemaValue {
  return messagePartsSchemaValue;
}

/** Nonempty protocol message content. */
export type MessageParts = Schema.Schema.Type<typeof messagePartsSchemaValue>;

const decodeMessagePartsEffect = Schema.decodeUnknown(messagePartsSchemaValue);

/**
 * Decode a message-parts payload and die on malformed persisted data.
 * @param value Value to process.
 * @returns The decoded message parts.
 */
export function decodeMessageParts(
  value: unknown,
): Effect.Effect<MessageParts> {
  return decodeMessagePartsEffect(value, {
    onExcessProperty: "error",
  }).pipe(Effect.orDie);
}
