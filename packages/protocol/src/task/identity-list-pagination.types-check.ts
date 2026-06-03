/**
 * @file Type-canary surface for the cursor-paginated list RPCs.
 *
 * Spans the `task` + `identity` layers (`TaskList` is the highest), so it lives
 * in `task/` and reaches DOWN to identity — never up. Imports the concrete
 * sibling modules, not the root barrel.
 *
 * Locks the wire shapes the cursor-paginated list RPCs fix:
 *   - `AgentsList` result `agents` is `AgentCard[]` (NOT a `Record`) and
 *     carries optional `nextCursor`; params carry optional `limit` /
 *     `cursor`.
 *   - `ContactsList` params carry optional `limit` / `cursor`; result
 *     carries optional `nextCursor`.
 *   - `TaskList` result carries optional `nextCursor` (interim — the
 *     final `TaskList` canaries land when the `tasks` item is reshaped
 *     to `TaskListItem`).
 *
 * Each compile-time equality assertion locks one invariant; a future
 * edit that narrows a field, reverts the Record→Array break, or drops
 * the cursor envelope turns it into a `tsc --build` failure. The
 * positive `agents: AgentCard[]` assertion plus the compile of every
 * `AgentsList` consumer is the proof the old `Record` shape is gone (no
 * negative `@ts-expect-error` canary needed).
 */
import type { Schema } from "effect";
import type { ListCursor } from "../schema-primitives.js";
import type { AgentCard } from "../identity/agents.js";
import { AgentsList } from "../identity/agents.js";
import { ContactsList } from "../identity/contacts.js";
import { TaskList } from "./tasks.js";

// ── Compile-time equality helper ─────────────────────────────────────
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

// ── AgentsList: Record → Array + cursor envelope ─────────────────────
type AgentsListParams = Schema.Schema.Type<typeof AgentsList.paramsSchema>;
type AgentsListResult = Schema.Schema.Type<typeof AgentsList.resultSchema>;

// `Schema.Array` produces `readonly T[]`, so the wire result is
// `readonly AgentCard[]`. The Record→Array break is locked: a `Record` shape
// would fail this equality.
type _A1 = Expect<Equal<AgentsListResult["agents"], readonly AgentCard[]>>;
type _A2 = Expect<
  Equal<AgentsListResult["nextCursor"], ListCursor | undefined>
>;
type _A3 = Expect<Equal<AgentsListParams["limit"], number | undefined>>;
type _A4 = Expect<Equal<AgentsListParams["cursor"], ListCursor | undefined>>;

export type _AgentsListPaginationCanary = _A1 | _A2 | _A3 | _A4;

// ── ContactsList: cursor envelope ────────────────────────────────────
type ContactsListParams = Schema.Schema.Type<typeof ContactsList.paramsSchema>;
type ContactsListResult = Schema.Schema.Type<typeof ContactsList.resultSchema>;

type _C1 = Expect<Equal<ContactsListParams["limit"], number | undefined>>;
type _C2 = Expect<Equal<ContactsListParams["cursor"], ListCursor | undefined>>;
type _C3 = Expect<
  Equal<ContactsListResult["nextCursor"], ListCursor | undefined>
>;

export type _ContactsListPaginationCanary = _C1 | _C2 | _C3;

// ── TaskList: nextCursor envelope (interim) ──────────────────────────
type TaskListResult = Schema.Schema.Type<typeof TaskList.resultSchema>;

// interim — the final TaskList canaries land when the `tasks` item is
// reshaped to `TaskListItem`.
export type _TaskListNextCursorCanary = Expect<
  Equal<TaskListResult["nextCursor"], ListCursor | undefined>
>;
