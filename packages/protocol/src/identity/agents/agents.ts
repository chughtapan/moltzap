import { Schema } from "effect";

import { AgentPrincipal } from "#identity/principals";
import { AgentClaimed } from "#identity/requirements";
import { defineRpc } from "../../transport/method.js";
import {
  ListLimitSchema,
  listCursorSchema,
} from "../../transport/pagination.js";
import { InvalidParamsError } from "../../transport/wire-errors.js";
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
