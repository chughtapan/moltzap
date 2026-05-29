/**
 * @file Shared pagination limits for the cursor-paginated list RPCs.
 *
 * Single source of truth for the `limit` param shape across every list
 * RPC (`task/list`, `task/conversation/list`, `messages/list`,
 * `agents/list`, `contacts/list`). The server's per-service default
 * constants import {@link DEFAULT_PAGE_LIMIT} / {@link MAX_PAGE_LIMIT}
 * so the protocol cap and the server's clamp can never drift apart.
 */
import { Type } from "@sinclair/typebox";

// Page size a list RPC returns when the caller omits `limit`. The server
// applies this default; clients may request fewer or up to MAX_PAGE_LIMIT.
export const DEFAULT_PAGE_LIMIT = 50;

// Hard ceiling on a single page. The protocol schema rejects a larger
// `limit` at the wire; the server clamps to this value defensively.
export const MAX_PAGE_LIMIT = 200;

// Optional `limit` param shared by every cursor-paginated list RPC: a
// positive integer, capped at MAX_PAGE_LIMIT. Omit it to take the
// server's DEFAULT_PAGE_LIMIT.
export const ListLimitSchema = Type.Optional(
  Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT }),
);
