import { Effect, Option, Schema } from "effect";
import {
  agentName,
  type agentsList as agentsListDefinition,
  type agentsSearch as agentsSearchDefinition,
  type AgentCard,
  type AgentId,
  type UserId,
  agentId,
} from "@moltzap/protocol/identity";
import {
  DEFAULT_PAGE_LIMIT,
  InvalidParamsError,
  type ParamsOf,
} from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import {
  DbTag,
  READ_PLANE_PAGE_SIZE,
  catchSqlErrorAsDefect,
  decodeListCursor,
  decodeSearchCursor,
  keysetWhere,
  normalizeSearchQuery,
  paginate,
  paginateSearchRows,
  sortKeyExpr,
  type ListCursorPosition,
} from "#db";
import { agentArm } from "#moltzap/runtime";
import type { AgentContext } from "#socket";

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
const agentsListPageEffect = Effect.fn("agents.list")(function* (
  input: AgentsListPageInput,
) {
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
  const { page, nextCursor } = paginate(rows, input.limit, positionOfAgentRow);
  return {
    agents: page.map(toAgentCard),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
});

const agentsListPage = (input: AgentsListPageInput) =>
  catchSqlErrorAsDefect(agentsListPageEffect(input));

interface AgentsSearchPageInput {
  readonly normalizedQuery: string;
  readonly agentId: AgentId;
  readonly lastId?: AgentId;
}

const agentsSearchPageEffect = Effect.fn("agents.search")(function* (
  input: AgentsSearchPageInput,
) {
  const db = yield* DbTag;
  const searchId = Schema.decodeOption(agentId)(input.normalizedQuery);
  let query = db
    .selectFrom("agents")
    .select([
      "id",
      "name",
      "display_name",
      "description",
      "status",
      "owner_user_id",
    ]);
  if (input.normalizedQuery !== "") {
    query = Option.isSome(searchId)
      ? query.where("id", "=", searchId.value)
      : query.where("name", "=", input.normalizedQuery);
  }
  if (input.lastId !== undefined) {
    query = query.where("id", ">", input.lastId);
  }
  const rows = yield* query
    .orderBy("id", "asc")
    .limit(READ_PLANE_PAGE_SIZE + 1);
  const binding = {
    kind: "agents" as const,
    query: input.normalizedQuery,
    agentId: input.agentId,
  };
  const { page, nextCursor } = paginateSearchRows(
    rows,
    binding,
    (row) => row.id,
  );
  return {
    agents: page.map(toAgentCard),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
});

const agentsSearchPage = (input: AgentsSearchPageInput) =>
  catchSqlErrorAsDefect(agentsSearchPageEffect(input));

const agentsListBody = Effect.fn("agents.list.handler")(function* (
  params: ParamsOf<typeof agentsListDefinition>,
) {
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
});

const agentsSearchBody = Effect.fn("agents.search.handler")(function* (
  params: ParamsOf<typeof agentsSearchDefinition>,
  ctx: AgentContext,
) {
  const normalizedQuery = normalizeSearchQuery(params.query);
  const binding = {
    kind: "agents" as const,
    query: normalizedQuery,
    agentId: ctx.agentId,
  };
  const position =
    params.cursor === undefined
      ? undefined
      : yield* decodeSearchCursor(params.cursor, binding);
  return yield* agentsSearchPage({
    normalizedQuery,
    agentId: ctx.agentId,
    ...(position === undefined
      ? {}
      : { lastId: Schema.decodeSync(agentId)(position.lastId) }),
  });
});

// ── @effect/rpc handler bodies ───────────────────────────────────────

/**
 * Provides the agents list runtime value.
 * @param params Request payload to process.
 * @returns The agents list result.
 */
export const agentsList: ServerHandler<typeof agentsListDefinition> = Effect.fn(
  "agentsList",
)(function* (params) {
  return yield* agentsListBody(params);
});

/**
 * Search agent cards by exact identifier or exact name.
 * @param params Request payload to process.
 * @returns One stable identifier-ordered page.
 */
export const agentsSearch: ServerHandler<typeof agentsSearchDefinition> =
  Effect.fn("agentsSearch")(function* (params) {
    return yield* agentsSearchBody(params, yield* agentArm);
  });
