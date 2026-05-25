/**
 * Cursor codec for the cursor-paginated list RPCs (`agents/list`,
 * `contacts/list`, `task/list`) — spec #693 Decision 1, Invariants 1-3.
 *
 * A `ListCursor` is the opaque wire token for keyset pagination. It
 * encodes the last emitted row's `(sortKey, id)` tuple — `sortKey` is
 * the ISO-8601 `created_at`, `id` is the row UUID (the tie-break). The
 * pair is a strict total order under `(created_at DESC, id ASC)`, which
 * eliminates the skip/dup a bare-timestamp cursor causes on equal-key
 * ties (Invariant 3).
 *
 * This module is the SINGLE sanctioned decoder of a cursor token
 * (Invariant 2 opacity; the server eslint config bans `atob` /
 * base64url `Buffer.from` everywhere else under `src/`). The encoding is
 * base64url of a canonical `sortKey id` payload so the token is
 * opaque on the wire and parses unambiguously server-side.
 */
import { Data, Effect } from "effect";
import type { ListCursor } from "@moltzap/protocol";
import type {
  Expression,
  ExpressionBuilder,
  ReferenceExpression,
  SqlBool,
} from "./kysely-vendor.js";

/**
 * Decoded cursor position. `sortKey` is the ISO-8601 of the ordering
 * column (`created_at`); `id` is the tie-break primary key (UUID).
 */
export interface ListCursorPosition {
  readonly sortKey: string;
  readonly id: string;
}

/**
 * A cursor token that does not decode to a `(sortKey, id)` pair. The
 * cursor is opaque to clients (Invariant 2), but a tampered or garbage
 * token is rejected at the boundary, never silently coerced. The
 * handler layer maps this to `InvalidParamsError` on the wire — a bad
 * cursor is an invalid client-supplied param, not an internal defect.
 */
export class InvalidCursorError extends Data.TaggedError("InvalidCursor")<{
  readonly message: string;
}> {}

// Field separator inside the canonical payload. A space cannot appear in
// the canonical ISO-8601 string Date.toISOString() emits (always
// T-separated, Z-suffixed) nor in a UUID, so the single split is
// unambiguous.
const CURSOR_FIELD_SEP = " ";

// A `sortKey` is valid iff it is the canonical ISO-8601 string for some
// instant — i.e. `Date(sortKey).toISOString()` round-trips to itself.
// This is exactly the form `created_at.toISOString()` emits server-side,
// and it rejects any tampered or non-canonical timestamp.
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

/**
 * Decode an opaque token. Fails (typed) on any token that is not the
 * base64url of a canonical `(ISO-8601 sortKey, UUID id)` payload.
 */
export function decodeListCursor(
  cursor: ListCursor | string,
): Effect.Effect<ListCursorPosition, InvalidCursorError> {
  return Effect.try({
    try: () => Buffer.from(cursor, "base64url"),
    catch: () => new InvalidCursorError({ message: "Cursor is not base64url" }),
  }).pipe(
    // Node's base64url decoder is permissive — it silently ignores
    // non-alphabet bytes, so `encodeListCursor(pos) + "!"` decodes to the
    // same payload. Reject any token that is not its own canonical
    // base64url re-encoding, so malformed cursors fail closed as
    // InvalidParamsError at the boundary instead of being accepted.
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
 * Millisecond-truncated sort-key expression for the `created_at` column.
 *
 * The cursor's `sortKey` is `created_at.toISOString()` — millisecond
 * resolution, because node-postgres hands JS a `Date` (ms) for a
 * `timestamptz` column that Postgres stores at microsecond resolution.
 * Comparing the full-precision column against that ms cursor skips rows
 * that share a millisecond but differ in microseconds. Truncating the
 * column to milliseconds in BOTH the order-by and the keyset predicate
 * makes the column's resolution match the cursor's, so `(sortKey, id)`
 * is a clean total order with no skip/dup (Invariant 3).
 *
 * Builder composition via `eb.fn` — not a raw `sql` template (Invariant
 * 6). Callers pass this same expression to `.orderBy(...)` and to
 * `keysetWhere` so the page boundary and the predicate agree.
 */
export function sortKeyExpr<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  createdAt: ReferenceExpression<DB, TB>,
): Expression<string> {
  return eb.fn<string>("date_trunc", [eb.val("milliseconds"), createdAt]);
}

/**
 * Keyset predicate for `(sortKey DESC, id ASC)` order: the WHERE that
 * keeps only rows strictly "after" the cursor position. Pure Kysely
 * builder composition (no raw SQL, Invariant 6):
 *
 *   `(sortKey, id) < (cursorSortKey, cursorId)` under DESC,id-ASC
 *   ⇒ sortKey < k OR (sortKey = k AND id > cursorId)
 *
 * `cols.sortKey` is the millisecond-truncated `created_at` expression
 * (see `sortKeyExpr`) — the SAME expression the query orders by —
 * and `cols.id` is the tie-break id column.
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
 * Split a `limit + 1` row batch into the emitted page plus the
 * nextCursor. When the batch overflowed (`rows.length > limit`), the
 * page is the first `limit` rows and `nextCursor` encodes the
 * `limit`-th row's position; otherwise this is the last page and
 * `nextCursor` is absent (Invariant 1).
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
