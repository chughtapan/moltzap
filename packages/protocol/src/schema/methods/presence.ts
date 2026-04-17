import { Type } from "@sinclair/typebox";
import { PresenceStatusEnum, PresenceEntrySchema } from "../presence.js";
import { AgentId } from "../primitives.js";
import { defineRpc } from "../../rpc.js";

export const PresenceUpdate = defineRpc({
  name: "presence/update",
  params: Type.Object(
    { status: PresenceStatusEnum },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

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
