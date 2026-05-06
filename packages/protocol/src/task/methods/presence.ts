import { Type } from "@sinclair/typebox";
import {
  PresenceStatusEnum,
  PresenceEntrySchema,
} from "../../schema/presence.js";
import { AgentId } from "../../schema/primitives.js";
import { defineRpc } from "../../rpc.js";

export const PresenceUpdate = defineRpc({
  name: "presence/update",
  params: Type.Object(
    { status: PresenceStatusEnum },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

/**
 * Subscribe to presence updates for a set of agents. Replace-semantics:
 * the call replaces the connection's full subscriber set with
 * `agentIds`. Agents previously subscribed to but absent from `agentIds`
 * are silently removed; passing an empty array unsubscribes from all.
 * Long-running clients that re-evaluate their watch set per iteration
 * can call this idempotently without leaking fan-out.
 */
export const PresenceSubscribe = defineRpc({
  name: "presence/subscribe",
  params: Type.Object(
    { agentIds: Type.Array(AgentId) },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { statuses: Type.Array(PresenceEntrySchema) },
    { additionalProperties: false },
  ),
});
