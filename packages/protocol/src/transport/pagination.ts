import { Schema } from "effect";
import { brandedString, type BrandedString } from "./wire-string.js";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export const ListLimitSchema = Schema.optional(
  Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(MAX_PAGE_LIMIT),
  ),
);

export type ListCursor = BrandedString<"ListCursor">;

const ListCursorSchema = brandedString("ListCursor", {
  description:
    "Opaque pagination cursor. Omit for the first page; pass the prior " +
    "response's nextCursor to fetch the next page. Treat as opaque; do " +
    "not parse, compare, or construct it.",
});

export function listCursorSchema(): typeof ListCursorSchema {
  return ListCursorSchema;
}
