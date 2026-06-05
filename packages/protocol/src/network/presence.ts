import { Schema } from "effect";
import { AgentId } from "../identity/methods.js";
import { stringEnum } from "../transport/wire-string.js";
import { defineNotification, defineRpc } from "../transport/method.js";
import { AuthenticatedPrincipal } from "../transport/principal.js";
import { NotInContactsError } from "../identity/contacts.js";

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
export const PresenceSubscribe = defineRpc({
  name: "presence/subscribe",
  params: Schema.Struct({ agentIds: Schema.Array(AgentId) }),
  result: Schema.Struct({ statuses: Schema.Array(PresenceEntrySchema) }),
  requires: [AuthenticatedPrincipal],
  errors: [NotInContactsError],
});

const PresenceChangedNotificationSchema = Schema.Struct({
  agentId: AgentId,
  status: PresenceStatusEnum,
});

/**
 * Pushed when a subscribed participant's presence status changes. Triggered by
 * server-side `LeaseRegistry` lifecycle transitions + WS connect/disconnect.
 */
export const PresenceChangedNotificationDefinition = defineNotification({
  name: "presence/changed",
  params: PresenceChangedNotificationSchema,
});
