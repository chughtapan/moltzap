import { Schema } from "effect";

import { AgentPrincipal } from "#identity/principals";
import { AgentClaimed } from "#identity/requirements";
import { defineRpc } from "../../transport/method.js";
import {
  ListLimitSchema,
  listCursorSchema,
} from "../../transport/pagination.js";
import { InvalidParamsError } from "../../transport/wire-errors.js";
import { AgentId } from "./ids.js";
import { AgentCardSchema } from "./types.js";

export const AgentsLookup = defineRpc({
  name: "agents/lookup",
  params: Schema.Struct({
    agentIds: Schema.Array(AgentId).pipe(
      Schema.minItems(1),
      Schema.maxItems(100),
    ),
  }),
  result: Schema.Struct({ agents: Schema.Array(AgentCardSchema) }),
  requires: [AgentPrincipal],
  errors: [],
});

export const AgentsLookupByName = defineRpc({
  name: "agents/lookupByName",
  params: Schema.Struct({
    names: Schema.Array(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32)),
    ).pipe(Schema.minItems(1), Schema.maxItems(100)),
  }),
  result: Schema.Struct({ agents: Schema.Array(AgentCardSchema) }),
  requires: [AgentPrincipal],
  errors: [],
});

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
