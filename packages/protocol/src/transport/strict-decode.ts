import { Either, Schema } from "effect";

const STRICT_DECODE = { onExcessProperty: "error" } as const;

export function decodesStrictly<A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
): boolean {
  return Either.match(
    Schema.decodeUnknownEither(schema)(value, STRICT_DECODE),
    { onLeft: () => false, onRight: () => true },
  );
}

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
