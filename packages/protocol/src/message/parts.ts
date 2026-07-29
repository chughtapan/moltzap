import { Effect, Schema } from "effect";
import { closedStructGuard, formatString } from "#transport";

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

const messagePartsSchemaValue = Schema.Array(partSchema).pipe(
  Schema.minItems(1),
  Schema.maxItems(10),
);
const messagePartsTextSchema = Schema.parseJson(messagePartsSchemaValue);

/**
 * Return the canonical message-parts schema.
 * @internal
 * @returns The message parts schema result.
 */
export function messagePartsSchema(): typeof messagePartsSchemaValue {
  return messagePartsSchemaValue;
}

const decodeMessagePartsEffect = Schema.decodeUnknown(messagePartsSchemaValue);
const decodeMessagePartsTextEffect = Schema.decodeUnknown(
  messagePartsTextSchema,
);

/**
 * Decode a message-parts payload and die on malformed persisted data.
 * @param value Value to process.
 * @returns The decoded message parts.
 */
export function decodeMessageParts(
  value: unknown,
): Effect.Effect<readonly Part[]> {
  return decodeMessagePartsEffect(value, {
    onExcessProperty: "error",
  }).pipe(Effect.orDie);
}

/**
 * Decode persisted plaintext message parts and die on malformed persisted data.
 * @param value Value to process.
 * @returns The decoded message parts text.
 */
export function decodeMessagePartsText(
  value: string,
): Effect.Effect<readonly Part[]> {
  return decodeMessagePartsTextEffect(value, {
    onExcessProperty: "error",
  }).pipe(Effect.orDie);
}

/** Return true when the value is a closed text part. */
export const validateTextPart = closedStructGuard(textPartSchema);
