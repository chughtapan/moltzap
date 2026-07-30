import { Schema } from "effect";

import { AgentPrincipal } from "#identity/principals";
import { ActiveAgent } from "#identity/requirements";
import { defineRpc } from "#transport/descriptor";
import {
  listLimitSchema,
  listCursorSchema,
  InvalidParamsError,
} from "#transport";
import { agentCardSchema } from "./types.js";

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
  requires: [AgentPrincipal, ActiveAgent],
  errors: [InvalidParamsError],
});
