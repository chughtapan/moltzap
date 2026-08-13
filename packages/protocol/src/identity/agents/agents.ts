import { Schema } from "effect";

import { AuthenticatedAgent } from "#identity/principals";
import { ActiveAgent } from "#identity/requirements";
import { defineRpc } from "#transport";
import {
  listLimitSchema,
  listCursorSchema,
  InvalidParamsError,
} from "#transport";
import { agentCardSchema } from "./types.js";

/**
 * Search agent cards visible to the active agent. The wire contract permits
 * omitted and blank queries; query interpretation and pagination policy belong
 * to the handler.
 *
 * @error InvalidParamsError when the query or cursor is invalid
 */
export const agentsSearch = defineRpc({
  name: "agent/identity/agents/search",
  params: Schema.Struct({
    query: Schema.optional(Schema.String),
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    agents: Schema.Array(agentCardSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [InvalidParamsError],
});

/** Defines the `agent/identity/agents/list` RPC contract. */
export const agentsList = defineRpc({
  name: "agent/identity/agents/list",
  params: Schema.Struct({
    limit: listLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    agents: Schema.Array(agentCardSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [InvalidParamsError],
});
