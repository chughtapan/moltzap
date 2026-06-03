import { Schema } from "effect";
import { AgentId } from "../identity/methods.js";
import { dateTimeStringSchema, stringEnum } from "../schema-primitives.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import { AgentPrincipal, AgentClaimed } from "../transport/principal.js";
import {
  UnauthorizedError,
  AlreadyConnected,
  InvalidParamsError,
} from "../transport/wire-errors.js";
import { NotInContactsError } from "../identity/contacts.js";

// ═══════════════════════════════════════════════════════════════════
// SHARED — value types used by 2+ blocks in this file.
//
// `PresenceStatusEnum` + `PresenceEntrySchema` are the presence shape both
// `presence/subscribe` (result entries) and `presence/changed` (notification)
// carry. Presence is server-derived from `LeaseRegistry` lifecycle:
// `online` = connected, no active lease; `working` = connected, ≥1 lease in
// GRANTED or CLAIMED; `offline` = disconnected. There is no client-set status:
// presence is a pure function of connection + lease state.
// ═══════════════════════════════════════════════════════════════════

const DateTimeString = dateTimeStringSchema();

const PresenceStatusEnum = stringEnum(["online", "working", "offline"]);

const PresenceEntrySchema = Schema.Struct({
  agentId: AgentId,
  status: PresenceStatusEnum,
});

// ═══════════════════════════════════════════════════════════════════
// network/connect
// ═══════════════════════════════════════════════════════════════════

// The HelloOk carries no payload: a connecting client already knows its own
// identity (an agent registers and stores its `agentId` via the
// `agents/register` HTTP flow; an app holds its appId), the protocol version is
// fixed by the build, and the server policy is not read by any client. The
// handshake's only observable outcome is success vs the typed
// `UnauthorizedError` / `ProtocolMismatchError` failure channel.
const HelloOkSchema = Schema.Struct({});

export type HelloOk = Schema.Schema.Type<typeof HelloOkSchema>;

/**
 * Reason discriminant carried in `ProtocolMismatchError.data.reason`:
 * `server-above-client-max` — the server is newer than the client's
 * `maxProtocol`; the client must update. `server-below-client-min` — the
 * client is newer than the server supports.
 */
export type ProtocolMismatchReason =
  | "server-above-client-max"
  | "server-below-client-min";

/**
 * Raised by `network/connect` when the client's `[minProtocol, maxProtocol]`
 * range does not bracket the server's `PROTOCOL_VERSION`. The server's
 * `connect.handlers.ts → checkProtocolRange` raises it BEFORE auth resolution
 * so old clients are rejected at the version gate. `data` carries the
 * diagnostic `{ reason, serverVersion, clientMinProtocol, clientMaxProtocol }`,
 * concretely typed so `error.data.reason` narrows at every reader.
 */
export class ProtocolMismatchError extends Schema.TaggedError<ProtocolMismatchError>()(
  "ProtocolMismatchError",
  {
    message: Schema.optional(Schema.String),
    data: Schema.Struct({
      reason: Schema.Literal(
        "server-above-client-max",
        "server-below-client-min",
      ),
      serverVersion: Schema.String,
      clientMinProtocol: Schema.String,
      clientMaxProtocol: Schema.String,
    }),
  },
) {
  static readonly message = "Client protocol version not supported";
}

/**
 * Authenticate a WebSocket connection. Must be the first message on a new
 * connection. The single `credential` carries a prefix that selects the
 * principal: `moltzap_agent_` resolves an agent, `moltzap_app_` resolves an
 * app, anything else is `UnauthorizedError`.
 *
 * - **Principal:** none — the unauthenticated handshake. No principal exists
 *   pre-auth, so `requires` is empty and no gate runs before it.
 * - **Params:** `credential`, `minProtocol`, `maxProtocol`.
 * - **Result:** an empty HelloOk; success is the signal (the client holds its
 *   own id).
 * @returns An empty HelloOk; success is the signal (the client holds its own id).
 * @error InvalidParamsError when the params are malformed
 * @error UnauthorizedError when the credential is invalid or carries no known prefix
 * @error ProtocolMismatchError when the client protocol version is not supported
 * @error AlreadyConnected when the principal already holds a live connection
 */
export const Connect = defineRpc({
  name: "network/connect",
  params: Schema.Struct({
    credential: Schema.String,
    minProtocol: Schema.String,
    maxProtocol: Schema.String,
  }),
  result: HelloOkSchema,
  requires: [],
  errors: [
    InvalidParamsError,
    UnauthorizedError,
    ProtocolMismatchError,
    AlreadyConnected,
  ],
});

// ═══════════════════════════════════════════════════════════════════
// network/ping
// ═══════════════════════════════════════════════════════════════════

/**
 * Liveness probe. Returns server timestamp.
 *
 * - **Principal:** `AgentPrincipal` head (no claimed refinement).
 * - **Result:** the server `ts`.
 */
export const NetworkPing = defineRpc({
  name: "network/ping",
  params: Schema.Struct({}),
  result: Schema.Struct({ ts: DateTimeString }),
  requires: [AgentPrincipal],
  errors: [],
});

// ═══════════════════════════════════════════════════════════════════
// presence/subscribe
//
// Presence is server-derived from `LeaseRegistry` lifecycle + WS
// connect/disconnect (see
// `@moltzap/server-core/network/services/presence.service.ts`); clients cannot
// manually set status. The wire surface is `presence/subscribe` (subscriber
// registry) + `presence/changed` (server-emitted notification).
// ═══════════════════════════════════════════════════════════════════

/**
 * Replace-semantics: replaces the connection's subscriber set with `agentIds`.
 * Empty array unsubscribes from all. Idempotent.
 *
 * - **Principal:** `AgentPrincipal` head + `AgentClaimed` (claimed/active agent).
 * - **Params:** `agentIds` to subscribe to.
 * - **Result:** the current `statuses` of the subscribed agents.
 * @error NotInContactsError when an agentId is outside the caller's contact-visible set
 */
export const PresenceSubscribe = defineRpc({
  name: "presence/subscribe",
  params: Schema.Struct({ agentIds: Schema.Array(AgentId) }),
  result: Schema.Struct({ statuses: Schema.Array(PresenceEntrySchema) }),
  requires: [AgentPrincipal, AgentClaimed],
  errors: [NotInContactsError],
});

// ═══════════════════════════════════════════════════════════════════
// presence/changed (notification)
// ═══════════════════════════════════════════════════════════════════

const PresenceChangedNotificationSchema = Schema.Struct({
  agentId: AgentId,
  status: PresenceStatusEnum,
});

/**
 * Pushed when a subscribed participant's presence status changes. Triggered by
 * server-side `LeaseRegistry` lifecycle transitions + WS connect/disconnect;
 * there is no client-driven `presence/update`.
 */
export const PresenceChangedNotificationDefinition = defineNotification({
  name: "presence/changed",
  params: PresenceChangedNotificationSchema,
});

// ═══════════════════════════════════════════════════════════════════
// catalog
// ═══════════════════════════════════════════════════════════════════

export const networkRpcMethods = [
  Connect,
  NetworkPing,
  PresenceSubscribe,
] as const;

export const networkNotifications = [
  PresenceChangedNotificationDefinition,
] as const;
