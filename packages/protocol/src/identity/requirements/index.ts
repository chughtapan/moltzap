/**
 * @file Identity-owned refinement requirement tags.
 */

import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import { ForbiddenError } from "#transport";

const activeAgentFailure = Schema.Union(ForbiddenError);

/**
 * Agent-principal refinement: the connected agent must be active.
 */
export class ActiveAgent extends RpcMiddleware.Tag<ActiveAgent>()(
  "@moltzap/protocol/requirement/ActiveAgent",
  { failure: activeAgentFailure },
) {}
