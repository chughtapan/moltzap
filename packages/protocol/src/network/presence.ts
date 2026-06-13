import { Schema } from "effect";
import { AgentId } from "#identity/agents";
import { stringEnum } from "#transport";
import { defineNotification, defineRpc } from "#transport";
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
  errors: [],
});

const PresenceChangedNotificationSchema = Schema.Struct({
  agentId: AgentId,
  status: PresenceStatusEnum,
});

/**
 * Pushed when a subscribed participant's presence status changes. Triggered by
 * server-side `LeaseRegistry` lifecycle transitions + WS connect/disconnect.
 */
export const AgentPresenceChangedNotificationDefinition = defineNotification({
  name: "agent/network/presence-changed",
  params: PresenceChangedNotificationSchema,
});

/**
 * Pushed to app subscribers when a watched agent's presence status changes.
 */
export const AppPresenceChangedNotificationDefinition = defineNotification({
  name: "app/network/presence-changed",
  params: PresenceChangedNotificationSchema,
});
