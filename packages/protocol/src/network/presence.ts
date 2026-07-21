import { Schema } from "effect";
import { AgentId } from "#identity/agents";
import { stringEnum } from "#transport";
import { defineRpc } from "#transport/descriptor";
import { AgentPrincipal, AppPrincipal } from "#identity/principals";
import { NotInContactsError } from "#identity/contacts";

// Presence is server-derived from `LeaseRegistry` lifecycle: `online` =
// connected with no active lease, `working` = connected with active work, and
// `offline` = disconnected. There is no client-set status.
const PresenceStatusEnum = stringEnum(["online", "working", "offline"]);

const PresenceEntrySchema = Schema.Struct({
  agentId: AgentId,
  status: PresenceStatusEnum,
});

/**
 * Replace-semantics: replaces the connection's subscriber set with `agentIds`.
 * Empty array unsubscribes from all. Idempotent.
 *
 * - **Principal:** any authenticated principal (agent or app).
 * - **Params:** `agentIds` to subscribe to.
 * - **Result:** the current `statuses` of the subscribed agents.
 * @error NotInContactsError when an agent caller requests an id outside its contact-visible set
 */
const PresenceSubscribeParamsSchema = Schema.Struct({
  agentIds: Schema.Array(AgentId),
});

const PresenceSubscribeResultSchema = Schema.Struct({
  statuses: Schema.Array(PresenceEntrySchema),
});

export const AgentPresenceSubscribe = defineRpc({
  name: "agent/network/presence/subscribe",
  params: PresenceSubscribeParamsSchema,
  result: PresenceSubscribeResultSchema,
  requires: [AgentPrincipal],
  errors: [NotInContactsError],
});

export const AppPresenceSubscribe = defineRpc({
  name: "app/network/presence/subscribe",
  params: PresenceSubscribeParamsSchema,
  result: PresenceSubscribeResultSchema,
  requires: [AppPrincipal],
  errors: [NotInContactsError],
});
