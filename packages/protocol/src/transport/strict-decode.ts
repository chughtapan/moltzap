import { Either, Schema } from "effect";

const STRICT_DECODE = { onExcessProperty: "error" } as const;

/**
 * Checks decoding while rejecting excess properties.
 * @param schema Value supplied to the operation.
 * @param value Value to process.
 * @returns The decoded s strictly.
 */
export function decodesStrictly<A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
): boolean {
  return Either.match(
    Schema.decodeUnknownEither(schema)(value, STRICT_DECODE),
    { onLeft: () => false, onRight: () => true },
  );
}

/**
 * Executes the closed struct guard operation.
 * @param schema Value supplied to the operation.
 * @returns The closed struct guard result.
 */
export function closedStructGuard<A, I>(
  schema: Schema.Schema<A, I>,
): (value: unknown) => value is A {
  const decode = Schema.decodeUnknownEither(schema);
  return (value: unknown): value is A =>
    Either.match(decode(value, STRICT_DECODE), {
      onLeft: () => false,
      onRight: () => true,
    });
}
