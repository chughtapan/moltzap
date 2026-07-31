import { Effect, Schema } from "effect";
import {
  agentName,
  type agentsList as agentsListDefinition,
  type AgentCard,
  type AgentId,
  type UserId,
} from "@moltzap/protocol/identity";
import {
  DEFAULT_PAGE_LIMIT,
  InvalidParamsError,
  type ParamsOf,
} from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import {
  DbTag,
  catchSqlErrorAsDefect,
  decodeListCursor,
  keysetWhere,
  paginate,
  sortKeyExpr,
  type ListCursorPosition,
} from "#db";

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
    name: Schema.decodeSync(agentName)(row.name),
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
    status:
      /* Safe because the surrounding invariant establishes this asserted shape. */ row.status as AgentCard["status"],
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

interface AgentsListPageInput {
  readonly limit: number;
  readonly pos?: ListCursorPosition;
}

// Keyset-paginated `agent/identity/agents/list` page over `(created_at DESC, id ASC)`
// across every registered agent. Returns the wire result shape; `nextCursor`
// present iff a further page exists.
function agentsListPage(input: AgentsListPageInput) {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const db = yield* DbTag;
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
        ]);
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

function agentsListBody(params: ParamsOf<typeof agentsListDefinition>) {
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
      limit: params.limit ?? DEFAULT_PAGE_LIMIT,
      pos,
    });
  }).pipe(Effect.withSpan("agents.list.handler"));
}

// ── @effect/rpc handler bodies ───────────────────────────────────────

/**
 * Provides the agents list runtime value.
 * @param params Request payload to process.
 * @returns The agents list result.
 */
export const agentsList: ServerHandler<typeof agentsListDefinition> = (
  params,
) => agentsListBody(params).pipe(Effect.withSpan("agentsList"));
