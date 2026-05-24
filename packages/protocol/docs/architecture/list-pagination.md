# List-RPC cursor pagination

One cursor-pagination convention covers the list-RPC surface
(`agents/list`, `contacts/list`, `task/list`). Spec #693 Decision 1 +
Invariants 1-3 are the contract; this doc is the wire-level summary.

## Shape

Every adopting RPC has the same envelope:

```
params: { limit?: integer (1..200), cursor?: ListCursor }
result: { <collection>: Array<Item>, nextCursor?: ListCursor }
```

- `limit` is optional with a server default and a hard wire maximum of
  200. `agents/list`, `contacts/list`, and `task/list` all cap at 200.
- `cursor` is optional and opaque. First page omits it; each subsequent
  page echoes the prior response's `nextCursor`.
- `nextCursor` is present iff more rows exist past this page; it is
  absent on the last page (Invariant 1).

`AgentsList` returns `agents: AgentCard[]` (an array, not a
`Record<AgentId, AgentCard>` map). A map has no stable page ordering, so
it cannot be cursor-paginated coherently; the array is the paginable
shape and matches `agents/lookup` / `agents/lookupByName`.

## Cursor

`ListCursor` (`schema-primitives.ts → listCursorSchema`) is a branded
opaque token. Clients never parse, compare, or construct it — they echo
`nextCursor` back unmodified (Invariant 2). The brand makes that opacity
structural: the only producer is the server's cursor codec
(`packages/server/src/db/list-cursor.ts`), and a server-side lint guard
bans decoding the token anywhere outside that module.

The token encodes the last emitted row's `(sortKey, id)` tuple —
`sortKey` is the ISO-8601 `created_at`, `id` is the row UUID (the
tie-break) — under a stable `(created_at DESC, id ASC)` total order. The
server fetches `limit + 1` rows; if the extra row exists, it emits
`nextCursor` from the `limit`-th row and returns only `limit` rows. A
bare-timestamp cursor skips or duplicates rows on equal-timestamp ties;
the `(sortKey, id)` tuple eliminates that (Invariant 3). The server-side
keyset predicate + slice live in `db/list-cursor.ts`
(`keysetWhere` / `paginate`); the per-RPC query plans live in
`task.service.ts`, `contact.service.ts`, and `agents-lookup.handlers.ts`.

## Left as-is

`MessagesList` keeps its `{ sinceSeq, limit } → { messages, hasMore }`
shape: its per-conversation seq cursor is already opaque, bounded, and
monotonic, and it is task+conversation scoped (request-bounded). It does
NOT adopt the `(sortKey, id)` convention. `AgentsLookup` /
`AgentsLookupByName` (`maxItems: 100`) and `PresenceSubscribe` are
request-bounded / subscription surfaces and are unchanged.

The legacy `task/conversation/list` cursor (a raw ISO `updated_at`
timestamp, in `task/services/conversation/list-pagination.ts`) predates
this convention. It is the model the convention supersedes; do not
extend it. See [Task / TaskConversation family](task-conversation-family.md).
