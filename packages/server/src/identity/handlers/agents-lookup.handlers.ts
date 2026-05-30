import { Effect } from "effect";
import {
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  DEFAULT_PAGE_LIMIT,
  InvalidParamsError,
  type AgentCard,
} from "@moltzap/protocol";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { AgentId as ServerAgentId } from "../../app/types.js";
import type { RpcMethodRegistry } from "../../transport/context.js";
import { defineNetworkMethod } from "../../transport/define-layered-method.js";
import { DbTag } from "../../app/layers.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";
import { visibleAgentIds } from "../../identity/services/agent-visibility.js";
import {
  decodeListCursor,
  keysetWhere,
  paginate,
  sortKeyExpr,
  type ListCursorPosition,
} from "../../db/list-cursor.js";

function toAgentCard(row: {
  id: AgentId;
  name: string;
  display_name: string | null;
  description: string | null;
  status: string;
  owner_user_id: UserId | null;
}): AgentCard {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
    status: row.status as AgentCard["status"],
    ownerUserId: row.owner_user_id === null ? undefined : row.owner_user_id,
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
  readonly callerAgentId: AgentId;
  readonly callerOwnerUserId: UserId | null;
  readonly limit: number;
  readonly pos?: ListCursorPosition;
}

// Keyset-paginated `agents/list` page over `(created_at DESC, id ASC)`
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
        .where("id", "in", ids as ServerAgentId[]);
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

export const agentsLookupHandlers: RpcMethodRegistry = [
  defineNetworkMethod(AgentsLookup, {
    callablePrincipal: "agent",
    // NOT contact-scoped. Per architect #481: "those are dereference-by-known-key,
    // so the privacy concern is at the enumeration verb, not the lookup verb."
    // The client uses this RPC to resolve peer `AgentCard`s for UI rendering of
    // conversation messages (see `service.resolveAgentName` and the bulk-history
    // lookup in `packages/client/src/service.ts`); contact-scoping it would render
    // conversation peers as UUIDs whenever the caller has not explicitly added
    // them as a contact. The dictionary-attack defense lives on the
    // `agents/lookupByName` verb below, where it actually applies.
    handler: (params) =>
      catchSqlErrorAsDefect(
        Effect.gen(function* () {
          const db = yield* DbTag;
          const rows = yield* db
            .selectFrom("agents")
            .select([
              "id",
              "name",
              "display_name",
              "description",
              "status",
              "owner_user_id",
            ])
            .where("id", "in", params.agentIds as ServerAgentId[]);
          return { agents: rows.map(toAgentCard) };
        }).pipe(Effect.withSpan("agents.lookup")),
      ),
  }),
  defineNetworkMethod(AgentsLookupByName, {
    callablePrincipal: "agent",
    // Contact-scoped per #481/#506. Names are 1-32 chars and human-chosen,
    // so a dictionary attack on the unfiltered RPC was tractable. The
    // `active` status filter is preserved (existing semantics); the
    // contact-graph filter is then layered on top of the name match.
    handler: (params, ctx) =>
      catchSqlErrorAsDefect(
        Effect.gen(function* () {
          const db = yield* DbTag;
          const matches = yield* db
            .selectFrom("agents")
            .select([
              "id",
              "name",
              "display_name",
              "description",
              "status",
              "owner_user_id",
            ])
            .where("name", "in", params.names)
            .where("status", "=", "active");
          if (matches.length === 0) return { agents: [] };
          const visibleIds = yield* visibleAgentIds({
            db,
            callerAgentId: ctx.agentId,
            callerOwnerUserId: ctx.ownerUserId,
            restrictTo: matches.map((r) => r.id),
          });
          const visibleSet = new Set<ServerAgentId>(visibleIds);
          return {
            agents: matches
              .filter((r) => visibleSet.has(r.id))
              .map(toAgentCard),
          };
        }).pipe(Effect.withSpan("agents.lookupByName")),
      ),
  }),
  defineNetworkMethod(AgentsList, {
    callablePrincipal: "agent",
    requiresActive: true,
    // Contact-scoped. `visibleAgentIds` is the entitlement filter; the
    // cursor + limit then run on the `agents` row query so page order is
    // stable regardless of the visibility query's order.
    handler: (params, ctx) =>
      Effect.gen(function* () {
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
      }).pipe(Effect.withSpan("agents.list.handler")),
  }),
];
