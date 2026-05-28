import { Data } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import { AgentId } from "../identity/methods.js";
import { dateTimeStringSchema, stringEnum } from "../schema-primitives.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import {
  registerErrorClass,
  type RpcErrorPayload,
} from "../transport/wire-errors.js";

const DateTimeString = dateTimeStringSchema();

// ── presence schemas ─────────────────────────────────────────────────

// v7 (architect plan #706 / codex r6 P2 #2) — narrowed from
// `["online", "offline", "away"]` to `["online", "working", "offline"]`.
// Presence is now server-derived from `LeaseRegistry` lifecycle:
// `online` = connected, no active lease; `working` = connected, ≥1
// lease in GRANTED or CLAIMED; `offline` = disconnected. The `away`
// state is gone — there is no longer a `presence/update` RPC for
// clients to set status manually (deleted in the same cutover).
const PresenceStatusEnum = stringEnum(["online", "working", "offline"]);

const PresenceEntrySchema = Type.Object(
  { agentId: AgentId, status: PresenceStatusEnum },
  { additionalProperties: false },
);

// ── network/connect ──────────────────────────────────────────────────

const RateLimitsSchema = Type.Object(
  {
    messagesPerMinute: Type.Integer(),
    requestsPerMinute: Type.Integer(),
  },
  { additionalProperties: false },
);

const PolicySchema = Type.Object(
  {
    maxMessageBytes: Type.Integer(),
    maxPartsPerMessage: Type.Integer(),
    maxTextLength: Type.Integer(),
    maxGroupParticipants: Type.Integer(),
    heartbeatIntervalMs: Type.Integer(),
    rateLimits: RateLimitsSchema,
  },
  { additionalProperties: false },
);

const HelloOkSchema = Type.Object(
  {
    protocolVersion: Type.String(),
    agentId: AgentId,
    policy: PolicySchema,
  },
  { additionalProperties: false },
);

/**
 * Authenticate a WebSocket connection. Must be the first message on a new connection.
 * @returns Connection metadata including agent ID, protocol version, conversations, and server policy.
 * @error UnauthorizedError when Invalid API key or JWT
 * @error ProtocolMismatchError when Client protocol version not supported
 */
export const Connect = defineRpc({
  name: "network/connect",
  params: Type.Union([
    Type.Object(
      {
        agentKey: Type.String(),
        minProtocol: Type.String(),
        maxProtocol: Type.String(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        sessionToken: Type.String(),
        minProtocol: Type.String(),
        maxProtocol: Type.String(),
      },
      { additionalProperties: false },
    ),
  ]),
  result: HelloOkSchema,
});

export type HelloOk = Static<typeof HelloOkSchema>;

/**
 * Raised by `network/connect` when the client's `[minProtocol,
 * maxProtocol]` range does not bracket the server's `PROTOCOL_VERSION`.
 *
 * Architect plan #706 v4 named the error in the `Connect` descriptor's
 * `@error` JSDoc; v8 (codex r7 P2 #1) lands the actual typed class so
 * the JSDoc claim is backed by a registered wire error. The
 * server-side handler (`@moltzap/server-core/identity/handlers/connect.handlers.ts
 * → checkProtocolRange`) raises this BEFORE auth resolution so old
 * clients are rejected at the version gate rather than after a
 * partial credential exchange.
 *
 * The `data` field carries the diagnostic triple
 * `{ clientMinProtocol, clientMaxProtocol, serverVersion, reason }`:
 *
 * - `reason: "server-above-client-max"` — `compareProtocolVersion(
 *   clientMaxProtocol, serverVersion) < 0`. The server is newer than
 *   the client knows how to talk to; the client must update.
 * - `reason: "server-below-client-min"` — `compareProtocolVersion(
 *   clientMinProtocol, serverVersion) > 0`. The client is newer than
 *   the server supports; the client must accept the legacy version
 *   or refuse to connect.
 *
 * Wire code `-32006` (next unclaimed in the registry; verified
 * against `-32000..-32024` at v8 architect-stub time per
 * `packages/protocol/CLAUDE.md` recipe step 5).
 *
 * The architect class body is `Effect.die("not implemented") /
 * throw new Error("not implemented")` is NOT applicable here — the
 * class is a `Data.TaggedError` subclass which is purely structural;
 * no body to stub. Impl-staff fills in the `handleConnect` /
 * `checkProtocolRange` wiring that raises this class.
 */
export class ProtocolMismatchError extends Data.TaggedError(
  "ProtocolMismatchError",
)<RpcErrorPayload> {
  static readonly code = -32006;
  static readonly message = "Client protocol version not supported";
}
registerErrorClass(ProtocolMismatchError);

/**
 * Reason discriminant carried in `ProtocolMismatchError.data.reason`.
 * Architect plan #706 v8 (codex r7 P2 #1).
 */
export type ProtocolMismatchReason =
  | "server-above-client-max"
  | "server-below-client-min";

// ── network/ping ─────────────────────────────────────────────────────

/**
 * Liveness probe. Returns server timestamp.
 */
export const NetworkPing = defineRpc({
  name: "network/ping",
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({ ts: DateTimeString }, { additionalProperties: false }),
});

// ── presence/* ───────────────────────────────────────────────────────

// v7 (architect plan #706 / codex r6 P2 #2): `PresenceUpdate` deleted.
// Presence is now server-derived from `LeaseRegistry` lifecycle (see
// `@moltzap/server-core/network/services/presence-projection.ts`);
// clients cannot manually set status. The surviving wire surface is
// `presence/subscribe` (subscriber registry) + `presence/changed`
// (server-emitted notification).

/**
 * Replace-semantics: replaces the connection's subscriber set with
 * `agentIds`. Empty array unsubscribes from all. Idempotent.
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

const PresenceChangedNotificationSchema = Type.Object(
  {
    agentId: AgentId,
    status: PresenceStatusEnum,
  },
  { additionalProperties: false },
);

/**
 * Pushed when a subscribed participant's presence status changes.
 * v7 (architect plan #706): triggered by server-side `LeaseRegistry`
 * lifecycle transitions, not by client-side `presence/update`
 * (deleted in the same cutover).
 */
export const PresenceChangedNotificationDefinition = defineNotification({
  name: "presence/changed",
  params: PresenceChangedNotificationSchema,
});

export const networkRpcMethods = [
  Connect,
  NetworkPing,
  PresenceSubscribe,
] as const;

export const networkNotifications = [
  PresenceChangedNotificationDefinition,
] as const;
