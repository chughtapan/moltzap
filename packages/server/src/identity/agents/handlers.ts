import { Effect } from "effect";
import { AgentsList } from "@moltzap/protocol/identity";
import { DEFAULT_PAGE_LIMIT, InvalidParamsError } from "@moltzap/protocol/rpc";
import type { AgentCard } from "@moltzap/protocol/identity";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import type { AgentContext } from "#socket";
import { DbTag } from "#db";
import { agentArm } from "#moltzap/runtime";
import { catchSqlErrorAsDefect } from "#db";
import { visibleAgentIds } from "./visibility.service.js";
import {
  decodeListCursor,
  keysetWhere,
  type ListCursorPosition,
  paginate,
  sortKeyExpr,
} from "#db";

interface AgentsListPageInput {
  readonly callerAgentId: AgentId;
  readonly callerOwnerUserId: UserId;
  readonly limit: number;
  readonly pos?: ListCursorPosition;
}

// ── @effect/rpc handler bodies ───────────────────────────────────────

export const agentsList: ServerHandler<typeof AgentsList> = (params) =>
  Effect.gen(function* () {
    return yield* agentsListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("agentsList"));

// Contact-scoped. `visibleAgentIds` is the entitlement filter; the cursor +
// limit then run on the `agents` row query so page order is stable regardless
// of the visibility query's order.
function agentsListBody(
  params: ParamsOf<typeof AgentsList>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const pos =
      params.cursor === undefined
        ? undefined
        : yield* decodeListCursor(params.cursor).pipe(
            Effect.catchTag("InvalidCursor", (err) =>
              Effect.fail(new InvalidParamsError({ message: err.message })),
            ),
          );
    return yield* agentsListPage({
      callerAgentId: ctx.agentId,
      callerOwnerUserId: ctx.ownerUserId,
      limit: params.limit ?? DEFAULT_PAGE_LIMIT,
      pos,
    });
  }).pipe(Effect.withSpan("agents.list.handler"));
}

// Keyset-paginated `agent/identity/agents/list` page over `(created_at DESC, id ASC)`
// restricted to the caller's visible set (Invariant 4). Returns the wire
// result shape; `nextCursor` present iff a further page exists.
function agentsListPage(input: AgentsListPageInput) {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const db = yield* DbTag;
      const ids = yield* visibleAgentIds({
        db,
        callerAgentId: input.callerAgentId,
        callerOwnerUserId: input.callerOwnerUserId,
      });
      if (ids.length === 0) return { agents: [] as AgentCard[] };
      let query = db
        .selectFrom("agents")
        .select([
          "id",
          "name",
          "display_name",
          "description",
          "status",
          "owner_user_id",
          "created_at",
        ])
        .where("id", "in", ids);
      if (input.pos !== undefined) {
        const cursorPos = input.pos;
        query = query.where((eb) =>
          keysetWhere(
            eb,
            { sortKey: sortKeyExpr(eb, "created_at"), id: "id" },
            cursorPos,
          ),
        );
      }
      const rows = yield* query
        .orderBy((eb) => sortKeyExpr(eb, "created_at"), "desc")
        .orderBy("id", "asc")
        .limit(input.limit + 1);
      const { page, nextCursor } = paginate(
        rows,
        input.limit,
        positionOfAgentRow,
      );
      return {
        agents: page.map(toAgentCard),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    }).pipe(Effect.withSpan("agents.list")),
  );
}

function toAgentCard(row: {
  id: AgentId;
  name: string;
  display_name: string | null;
  description: string | null;
  status: string;
  owner_user_id: UserId;
}): AgentCard {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
    status: row.status as AgentCard["status"],
    ownerUserId: row.owner_user_id,
  };
}

// `created_at` is the keyset ordering column only; never projected onto `AgentCard`.
function positionOfAgentRow(row: { id: AgentId; created_at: Date }): {
  readonly sortKey: string;
  readonly id: string;
} {
  return { sortKey: row.created_at.toISOString(), id: row.id };
}
