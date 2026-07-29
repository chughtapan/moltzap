import { Schema, type Brand } from "effect";

/** Default value for page limit. */
export const DEFAULT_PAGE_LIMIT = 50;
/** Provides the max page limit runtime value. */
export const MAX_PAGE_LIMIT = 200;

/** Validates and decodes list limit values. */
export const listLimitSchema = Schema.optional(
  Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(MAX_PAGE_LIMIT),
  ),
);

/** Represents list cursor values. */
export type ListCursor = string & Brand.Brand<"ListCursor">;

const listCursorSchemaValue: Schema.Schema<ListCursor, string> =
  Schema.String.pipe(
    Schema.brand("ListCursor"),
    Schema.annotations({
      description:
        "Opaque pagination cursor. Omit for the first page; pass the prior " +
        "response's nextCursor to fetch the next page. Treat as opaque; do " +
        "not parse, compare, or construct it.",
    }),
  );

/**
 * Executes the list cursor schema operation.
 * @returns The list cursor schema result.
 */
export function listCursorSchema(): typeof listCursorSchemaValue {
  return listCursorSchemaValue;
}
