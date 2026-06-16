/**
 * Cursor codec for the cursor-paginated list RPCs (`agent/identity/agents/list`,
 * `agent/identity/contacts/list`, `agent/task/list`). A `ListCursor` is base64url of the last
 * emitted row's `(sortKey, id)` tuple, ordered `(created_at DESC, id ASC)`.
 *
 * This module is the only sanctioned decoder of a cursor token; the
 * server eslint config bans `atob` / base64url `Buffer.from` elsewhere
 * under `src/` so consumers cannot couple to the encoding.
 */
import { Data, Effect } from "effect";
import type { ListCursor } from "@moltzap/protocol/rpc";
import type {
  Expression,
  ExpressionBuilder,
  ReferenceExpression,
  SqlBool,
} from "./kysely-vendor.js";

/** `sortKey` is the ISO-8601 `created_at`; `id` is the tie-break UUID. */
export interface ListCursorPosition {
  readonly sortKey: string;
  readonly id: string;
}

/**
 * A cursor token that does not decode to a `(sortKey, id)` pair. The
 * handler layer maps this to `InvalidParamsError` on the wire — a bad
 * cursor is an invalid client-supplied param, not an internal defect.
 */
export class InvalidCursorError extends Data.TaggedError("InvalidCursor")<{
  readonly message: string;
}> {}

// A space cannot appear in a canonical ISO-8601 string nor a UUID, so the
// single split is unambiguous.
const CURSOR_FIELD_SEP = " ";

// Canonical iff `new Date(sortKey).toISOString()` round-trips — the form
// `created_at.toISOString()` emits; rejects any non-canonical timestamp.
function isCanonicalIso8601(sortKey: string): boolean {
  const parsed = Date.parse(sortKey);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === sortKey;
}
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encode the last emitted row's position into the opaque wire token. */
export function encodeListCursor(pos: ListCursorPosition): ListCursor {
  const payload = `${pos.sortKey}${CURSOR_FIELD_SEP}${pos.id}`;
  return Buffer.from(payload, "utf8").toString("base64url") as ListCursor;
}

/** Decode a token, failing typed on anything but a canonical payload. */
export function decodeListCursor(
  cursor: ListCursor | string,
): Effect.Effect<ListCursorPosition, InvalidCursorError> {
  return Effect.try({
    try: () => Buffer.from(cursor, "base64url"),
    catch: () => new InvalidCursorError({ message: "Cursor is not base64url" }),
  }).pipe(
    // Node's base64url decoder ignores non-alphabet bytes (so `cursor + "!"`
    // would decode fine); reject any token that is not its own canonical
    // re-encoding so malformed cursors fail closed at the boundary.
    Effect.flatMap((buf) =>
      buf.toString("base64url") === cursor
        ? Effect.succeed(buf.toString("utf8"))
        : Effect.fail(
            new InvalidCursorError({
              message: "Cursor is not canonical base64url",
            }),
          ),
    ),
    Effect.flatMap(parseDecodedPayload),
  );
}

function parseDecodedPayload(
  decoded: string,
): Effect.Effect<ListCursorPosition, InvalidCursorError> {
  const parts = decoded.split(CURSOR_FIELD_SEP);
  if (parts.length !== 2) {
    return Effect.fail(
      new InvalidCursorError({
        message: "Cursor payload is not a (sortKey, id) pair",
      }),
    );
  }
  const [sortKey, id] = parts as [string, string];
  if (!isCanonicalIso8601(sortKey)) {
    return Effect.fail(
      new InvalidCursorError({ message: "Cursor sortKey is not ISO-8601" }),
    );
  }
  if (!UUID_RE.test(id)) {
    return Effect.fail(
      new InvalidCursorError({ message: "Cursor id is not a UUID" }),
    );
  }
  return Effect.succeed({ sortKey, id });
}

/**
 * Millisecond-truncated `created_at` sort-key expression.
 *
 * The cursor's `sortKey` is ms-resolution (node-postgres hands JS a
 * `Date`), but Postgres stores `timestamptz` at microsecond resolution —
 * comparing full-precision column against the ms cursor would skip rows
 * sharing a millisecond. Truncating to ms in BOTH the order-by and
 * `keysetWhere` predicate keeps `(sortKey, id)` a clean total order.
 */
export function sortKeyExpr<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  createdAt: ReferenceExpression<DB, TB>,
): Expression<string> {
  return eb.fn<string>("date_trunc", [eb.val("milliseconds"), createdAt]);
}

/**
 * Keyset predicate keeping only rows strictly after the cursor under
 * `(sortKey DESC, id ASC)`: `sortKey < k OR (sortKey = k AND id > id)`.
 * `cols.sortKey` MUST be the same expression the query orders by
 * (`sortKeyExpr`).
 */
export function keysetWhere<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  cols: {
    readonly sortKey: Expression<string>;
    readonly id: ReferenceExpression<DB, TB>;
  },
  pos: ListCursorPosition,
): Expression<SqlBool> {
  return eb.or([
    eb(cols.sortKey, "<", pos.sortKey),
    eb.and([eb(cols.sortKey, "=", pos.sortKey), eb(cols.id, ">", pos.id)]),
  ]);
}

/**
 * Split a `limit + 1` batch into the emitted page plus `nextCursor`.
 * An overflowed batch (`rows.length > limit`) yields the first `limit`
 * rows and a `nextCursor`; otherwise it is the last page (no cursor).
 */
export function paginate<Row>(
  rows: ReadonlyArray<Row>,
  limit: number,
  positionOf: (row: Row) => ListCursorPosition,
): { readonly page: ReadonlyArray<Row>; readonly nextCursor?: ListCursor } {
  if (rows.length <= limit) {
    return { page: rows };
  }
  const page = rows.slice(0, limit);
  const last = page[page.length - 1]!;
  return { page, nextCursor: encodeListCursor(positionOf(last)) };
}
