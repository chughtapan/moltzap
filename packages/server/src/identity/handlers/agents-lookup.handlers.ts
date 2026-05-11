import { Effect } from "effect";
import {
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  type AgentCard,
} from "@moltzap/protocol";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { AgentId as ServerAgentId } from "../../app/types.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineNetworkMethod } from "../../rpc/define-layered-method.js";
import { DbTag } from "../../app/layers.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";
import { visibleAgentIds } from "../../services/agent-visibility.js";

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

export const agentsLookupHandlers: RpcMethodRegistry = [
  defineNetworkMethod(AgentsLookup, {
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
        }),
      ),
  }),
  defineNetworkMethod(AgentsLookupByName, {
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
        }),
      ),
  }),
  defineNetworkMethod(AgentsList, {
    requiresActive: true,
    // Contact-scoped per #481.
    handler: (_params, ctx) =>
      catchSqlErrorAsDefect(
        Effect.gen(function* () {
          const db = yield* DbTag;
          const ids = yield* visibleAgentIds({
            db,
            callerAgentId: ctx.agentId,
            callerOwnerUserId: ctx.ownerUserId,
          });
          if (ids.length === 0) return { agents: {} };
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
            .where("id", "in", ids as ServerAgentId[]);
          const agents: Record<string, AgentCard> = {};
          for (const row of rows) {
            agents[row.id] = toAgentCard(row);
          }
          return { agents };
        }),
      ),
  }),
];
