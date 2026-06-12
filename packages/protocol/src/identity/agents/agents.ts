import { Schema } from "effect";

import { AgentPrincipal } from "#identity/principals";
import { AgentClaimed } from "#identity/requirements";
import { defineRpc } from "#transport";
import { ListLimitSchema, listCursorSchema } from "#transport";
import { InvalidParamsError } from "#transport";
import { AgentCardSchema } from "./types.js";

export const AgentsList = defineRpc({
  name: "agents/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    agents: Schema.Array(AgentCardSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal, AgentClaimed],
  errors: [InvalidParamsError],
});
