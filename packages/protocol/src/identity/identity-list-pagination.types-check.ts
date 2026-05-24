/**
 * @file Track A (#696) type-canary surface for the cursor-paginated
 * list RPCs.
 *
 * Locks the wire shapes spec #693 Decision 1 fixes:
 *   - `AgentsList` result `agents` is `AgentCard[]` (NOT a `Record`) and
 *     carries optional `nextCursor`; params carry optional `limit` /
 *     `cursor`.
 *   - `ContactsList` params carry optional `limit` / `cursor`; result
 *     carries optional `nextCursor`.
 *   - `TaskList` result carries optional `nextCursor` (INTERIM — Track B
 *     owns the FINAL `TaskList` canaries when it reshapes the `tasks`
 *     item to `TaskListItem`).
 *
 * Each compile-time equality assertion locks one invariant; a future
 * edit that narrows a field, reverts the Record→Array break, or drops
 * the cursor envelope turns it into a `tsc --build` failure. The
 * positive `agents: AgentCard[]` assertion plus the compile of every
 * `AgentsList` consumer is the proof the old `Record` shape is gone (no
 * negative `@ts-expect-error` canary needed).
 */
import type { Static } from "@sinclair/typebox";
import type { AgentCard, ListCursor } from "../index.js";
import { AgentsList, ContactsList } from "../index.js";
import { TaskList } from "../task/index.js";

// ── Compile-time equality helper ─────────────────────────────────────
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

// ── AgentsList: Record → Array + cursor envelope ─────────────────────
type AgentsListParams = Static<typeof AgentsList.paramsSchema>;
type AgentsListResult = Static<typeof AgentsList.resultSchema>;

type _A1 = Expect<Equal<AgentsListResult["agents"], AgentCard[]>>;
type _A2 = Expect<
  Equal<AgentsListResult["nextCursor"], ListCursor | undefined>
>;
type _A3 = Expect<Equal<AgentsListParams["limit"], number | undefined>>;
type _A4 = Expect<Equal<AgentsListParams["cursor"], ListCursor | undefined>>;

export type _AgentsListPaginationCanary = _A1 | _A2 | _A3 | _A4;

// ── ContactsList: cursor envelope ────────────────────────────────────
type ContactsListParams = Static<typeof ContactsList.paramsSchema>;
type ContactsListResult = Static<typeof ContactsList.resultSchema>;

type _C1 = Expect<Equal<ContactsListParams["limit"], number | undefined>>;
type _C2 = Expect<Equal<ContactsListParams["cursor"], ListCursor | undefined>>;
type _C3 = Expect<
  Equal<ContactsListResult["nextCursor"], ListCursor | undefined>
>;

export type _ContactsListPaginationCanary = _C1 | _C2 | _C3;

// ── TaskList: nextCursor envelope (INTERIM — Track B owns final) ──────
type TaskListResult = Static<typeof TaskList.resultSchema>;

// interim — Track B owns final TaskList canaries when it reshapes the
// `tasks` item to `TaskListItem`.
export type _TaskListNextCursorCanary = Expect<
  Equal<TaskListResult["nextCursor"], ListCursor | undefined>
>;
