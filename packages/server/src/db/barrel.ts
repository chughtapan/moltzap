/** @file Internal DB/query helper barrel for server-core source aliases. */

import { Context } from "effect";

import type { Db } from "./database.js";

/** Implements the database service tag exposed by this boundary. */
export class DbTag extends Context.Tag("moltzap/Db")<DbTag, Db>() {}

/** Re-exports the public types from `./database.js`. */
export type { Database, Db, MessageRow } from "./database.js";
/** Re-exports the public API from `./effect-kysely-toolkit.js`. */
export {
  catchSqlErrorAsDefect,
  makeEffectKysely,
  rawQuery,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
} from "./effect-kysely-toolkit.js";
/** Re-exports the public API from `./list-cursor.js`. */
export {
  decodeListCursor,
  keysetWhere,
  paginate,
  sortKeyExpr,
} from "./list-cursor.js";
/** Re-exports the public API from `./list-cursor.js`. */
export type { ListCursorPosition } from "./list-cursor.js";
/** Re-exports the public API from `./search-read-cursor.js`. */
export {
  READ_PLANE_PAGE_SIZE,
  decodeConversationCheckpoint,
  decodeConversationReadCursor,
  decodeSearchCursor,
  encodeConversationCheckpoint,
  encodeConversationReadCursor,
  normalizeSearchQuery,
  paginateSearchRows,
} from "./search-read-cursor.js";
/** Re-exports the public API from `kysely`. */
export { sql } from "kysely";
