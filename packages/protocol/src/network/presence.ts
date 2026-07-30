import { Schema } from "effect";
import { agentId } from "#identity/agents";
import { stringEnum } from "#transport";
import { defineRpc } from "#transport/descriptor";
import { AgentPrincipal, AppPrincipal } from "#identity/principals";
import { NotInContactsError } from "#identity/contacts";

// Presence is server-derived from `LeaseRegistry` lifecycle: `online` =
// connected with no active lease, `working` = connected with active work, and
// `offline` = disconnected. There is no client-set status.
const presenceStatusEnum = stringEnum(["online", "working", "offline"]);

const presenceEntrySchema = Schema.Struct({
  agentId: agentId,
  status: presenceStatusEnum,
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
const presenceSubscribeParamsSchema = Schema.Struct({
  agentIds: Schema.Array(agentId),
});

const presenceSubscribeResultSchema = Schema.Struct({
  statuses: Schema.Array(presenceEntrySchema),
});

/** Defines the `agent/network/presence/subscribe` RPC contract. */
export const agentPresenceSubscribe = defineRpc({
  name: "agent/network/presence/subscribe",
  params: presenceSubscribeParamsSchema,
  result: presenceSubscribeResultSchema,
  requires: [AgentPrincipal],
  errors: [NotInContactsError],
});

/** Defines the `app/network/presence/subscribe` RPC contract. */
export const appPresenceSubscribe = defineRpc({
  name: "app/network/presence/subscribe",
  params: presenceSubscribeParamsSchema,
  result: presenceSubscribeResultSchema,
  requires: [AppPrincipal],
  errors: [],
});
