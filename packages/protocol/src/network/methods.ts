import { Type, type Static } from "@sinclair/typebox";
import { AgentId } from "../identity/methods.js";
import { dateTimeStringSchema, stringEnum } from "../schema-primitives.js";
import { defineRpc, defineNotification } from "../transport/method.js";

const DateTimeString = dateTimeStringSchema();

// ── presence schemas ─────────────────────────────────────────────────

const PresenceStatusEnum = stringEnum(["online", "offline", "away"]);

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

// ── network/ping ─────────────────────────────────────────────────────

export const NetworkPing = defineRpc({
  name: "network/ping",
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({ ts: DateTimeString }, { additionalProperties: false }),
});

// ── presence/* ───────────────────────────────────────────────────────

export const PresenceUpdate = defineRpc({
  name: "presence/update",
  params: Type.Object(
    { status: PresenceStatusEnum },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

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

export const PresenceChangedNotificationDefinition = defineNotification({
  name: "presence/changed",
  params: PresenceChangedNotificationSchema,
});

export const networkRpcMethods = [
  Connect,
  NetworkPing,
  PresenceUpdate,
  PresenceSubscribe,
] as const;

export const networkNotifications = [
  PresenceChangedNotificationDefinition,
] as const;
