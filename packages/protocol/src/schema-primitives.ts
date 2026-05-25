import {
  FormatRegistry,
  Type,
  type Static,
  type TString,
  type TNumber,
} from "@sinclair/typebox";
import type { Brand } from "effect";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set(
    "uuid",
    (value) => typeof value === "string" && UUID_RE.test(value),
  );
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => {
    if (typeof value !== "string" || !DATE_TIME_RE.test(value)) return false;
    return Number.isFinite(Date.parse(value));
  });
}
if (!FormatRegistry.Has("uri")) {
  FormatRegistry.Set(
    "uri",
    (value) => typeof value === "string" && URI_RE.test(value),
  );
}

export type BrandedString<BrandName extends string> = string &
  Brand.Brand<BrandName>;
export type BrandedNumber<BrandName extends string> = number &
  Brand.Brand<BrandName>;

export function brandedString<const BrandName extends string>(
  brand: BrandName,
  options: Parameters<typeof Type.String>[0] = {},
) {
  return Type.String({
    ...options,
    description: options.description ?? `Branded ${brand}`,
  }) as TString & { static: BrandedString<BrandName> };
}

export function brandedNumber<const BrandName extends string>(
  brand: BrandName,
  options: Parameters<typeof Type.Number>[0] = {},
) {
  return Type.Number({
    ...options,
    description: options.description ?? `Branded ${brand}`,
  }) as TNumber & { static: BrandedNumber<BrandName> };
}

export function brandedId<const BrandName extends string>(brand: BrandName) {
  return brandedString(brand, {
    format: "uuid",
    description: `Branded ${brand}`,
  });
}

export function stringEnum<T extends string[]>(values: [...T]) {
  return Type.String({ enum: values }) as TString & { static: T[number] };
}

const DateTimeStringSchema = Type.String({ format: "date-time" });

export type DateTimeString = Static<typeof DateTimeStringSchema>;

export function dateTimeStringSchema(): typeof DateTimeStringSchema {
  return DateTimeStringSchema;
}

// Opaque pagination token for the cursor-paginated list RPCs. The brand
// makes opacity structural: only the server's `list-cursor` codec
// produces this type; clients echo `nextCursor` back unmodified.
export type ListCursor = BrandedString<"ListCursor">;

export function listCursorSchema(): TString & { static: ListCursor } {
  return brandedString("ListCursor", {
    description:
      "Opaque pagination cursor. Omit for the first page; pass the prior " +
      "response's nextCursor to fetch the next page. Treat as opaque — do " +
      "not parse, compare, or construct it.",
  });
}

// Recursive JSON value — pins the wire-payload shape so AJV-decoded
// `data` fields cannot smuggle Date / Map / Symbol. The hand-written
// type alias is broader than Static<typeof JsonValue> so producer call
// sites can pass readonly arrays / records (TypeBox's inferred Static
// drops the readonly modifier).
export const JsonValueSchema = Type.Recursive(
  (Self) =>
    Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Self),
      Type.Record(Type.String(), Self),
    ]),
  { $id: "JsonValue" },
);
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [k: string]: JsonValue };
