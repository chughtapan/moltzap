import { type Brand, Schema } from "effect";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export type ListCursor = string & Brand.Brand<"ListCursor">;

export const ListLimitSchema = Schema.optional(
  Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(MAX_PAGE_LIMIT),
  ),
);

export function listCursorSchema(): typeof ListCursorSchema {
  return ListCursorSchema;
}

const ListCursorSchema: Schema.Schema<ListCursor, string> = Schema.String.pipe(
  Schema.brand("ListCursor"),
  Schema.annotations({
    description:
      "Opaque pagination cursor. Omit for the first page; pass the prior " +
      "response's nextCursor to fetch the next page. Treat as opaque; do " +
      "not parse, compare, or construct it.",
  }),
);
