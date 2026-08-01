import { Schema } from "effect";

import { AgentPrincipal } from "#identity/principals";
import { ActiveAgent } from "#identity/requirements";
import { defineRpc } from "#transport/descriptor";
import {
  InvalidParamsError,
  listCursorSchema,
  ListLimitSchema,
} from "#transport";
import { AgentCardSchema } from "./types.js";

export const AgentsList = defineRpc({
  name: "agent/identity/agents/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    agents: Schema.Array(AgentCardSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [InvalidParamsError],
});
