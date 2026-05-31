import { Either, Schema } from "effect";
import {
  stringEnum,
  dateTimeStringSchema,
  brandedId,
  listCursorSchema,
  formatString,
} from "../schema-primitives.js";
import { ListLimitSchema } from "../pagination.js";
import { defineRpc } from "../transport/method.js";

const DateTimeString = dateTimeStringSchema();

export const UserId = brandedId("UserId");
export type UserId = Schema.Schema.Type<typeof UserId>;
export const AgentId = brandedId("AgentId");
export type AgentId = Schema.Schema.Type<typeof AgentId>;

const AgentMetadataSchema = Schema.Struct({
  purpose: Schema.optional(Schema.Array(Schema.String)),
  description: Schema.optional(Schema.String),
  tags: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});

const AgentSchema = Schema.Struct({
  id: AgentId,
  ownerUserId: Schema.optional(UserId),
  name: Schema.String.pipe(
    Schema.minLength(3),
    Schema.maxLength(32),
    Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
  ),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  agentType: Schema.optional(stringEnum(["OpenClaw", "NanoClaw"])),
  metadata: Schema.optional(AgentMetadataSchema),
  status: stringEnum(["pending_claim", "active", "suspended"]),
  createdAt: DateTimeString,
});

const AgentCardSchema = AgentSchema.omit("createdAt");

const AgentOwnershipSchema = Schema.Struct({
  agentId: AgentId,
  ownerId: Schema.String,
});

export type Agent = Schema.Schema.Type<typeof AgentSchema>;
export type AgentCard = Schema.Schema.Type<typeof AgentCardSchema>;

// Strict, excess-rejecting type guards over agent identity records. A bare
// `Schema.is` accepts extra keys (Effect strips them by default); these
// records arrive from storage and registration, where an extra key signals a
// malformed record and must reject, so each guard decodes with
// `{ onExcessProperty: "error" }`.
const closedGuard =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (value: unknown): value is A =>
    Either.match(
      Schema.decodeUnknownEither(schema)(value, { onExcessProperty: "error" }),
      { onLeft: () => false, onRight: () => true },
    );

export const validateAgent = closedGuard(AgentSchema);
export const validateAgentCard = closedGuard(AgentCardSchema);

export function agentOwnershipSchema(): typeof AgentOwnershipSchema {
  return AgentOwnershipSchema;
}

/**
 * Register a new agent and receive an API key.
 * @returns Agent ID, API key, and claim URL.
 * @error ConflictError when Agent name already taken
 * @error InvalidParamsError when Name doesn't match required pattern
 */
export const Register = defineRpc({
  name: "agents/register",
  params: Schema.Struct({
    name: Schema.String.pipe(
      Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
    ),
    description: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
    inviteCode: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  }),
  result: Schema.Struct({
    agentId: AgentId,
    apiKey: Schema.String,
    claimUrl: formatString("uri"),
    claimToken: Schema.String,
  }),
});

/**
 * Programmatic claim path. Pairs with `agents/register` to give automated
 * callers (provisioning scripts, app-server self-mints, BYOA harnesses) a
 * two-step flow that does not require knowing or sharing the agent
 * `apiKey`: register → take the returned `claimToken` → claim with the
 * intended `ownerUserId`.
 *
 * Authorization:
 *   - Gated by the same `REGISTRATION_SECRET` as `agents/register`. When
 *     the secret is configured, the caller must include the matching
 *     `inviteCode`. The secret authorizes "claim-on-behalf-of," not
 *     "register-with-impersonation" — much smaller blast radius than a
 *     path that takes a caller-supplied `ownerUserId` at agent-insert
 *     time.
 *
 * Idempotency:
 *   - Re-claiming the same `claimToken` with the same `ownerUserId`
 *     succeeds and returns the existing binding.
 *   - Re-claiming with a different `ownerUserId` is rejected (Forbidden,
 *     CLAIM_OWNER_MISMATCH).
 *   - A non-matching `claimToken` is rejected (Unauthorized,
 *     CLAIM_NOT_FOUND). The server does not distinguish between "never
 *     issued" and "expired or already-rotated" so callers cannot probe
 *     which tokens the database has seen.
 *
 * Recommended order: `agents/register → agents/claim → network/connect`
 * (the apiKey from register opens the WebSocket; owner-gated RPCs
 * unblock once claim has bound `ownerUserId`).
 */
export const Claim = defineRpc({
  name: "agents/claim",
  params: Schema.Struct({
    claimToken: Schema.String.pipe(Schema.minLength(1)),
    ownerUserId: formatString("uuid"),
    inviteCode: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  }),
  result: Schema.Struct({
    agentId: AgentId,
    ownerUserId: formatString("uuid"),
  }),
});

/**
 * Create an agent invite for a phone number.
 */
export const InviteAgent = defineRpc({
  name: "agents/invite",
  params: Schema.Struct({ phone: Schema.optional(Schema.String) }),
  result: Schema.Struct(
    {},
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
});

/**
 * Look up agents by their UUIDs. Returns agent cards for found agents.
 */
export const AgentsLookup = defineRpc({
  name: "agents/lookup",
  params: Schema.Struct({
    agentIds: Schema.Array(formatString("uuid")).pipe(
      Schema.minItems(1),
      Schema.maxItems(100),
    ),
  }),
  result: Schema.Struct({ agents: Schema.Array(AgentCardSchema) }),
});

/**
 * Look up agents by their short names.
 */
export const AgentsLookupByName = defineRpc({
  name: "agents/lookupByName",
  params: Schema.Struct({
    names: Schema.Array(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32)),
    ).pipe(Schema.minItems(1), Schema.maxItems(100)),
  }),
  result: Schema.Struct({ agents: Schema.Array(AgentCardSchema) }),
});

/**
 * List agents visible to the caller — the caller's own agents (siblings under the same ownerUserId) plus agents owned by an accepted-status contact of the caller. Unclaimed callers see only themselves.
 */
export const AgentsList = defineRpc({
  name: "agents/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    agents: Schema.Array(AgentCardSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
});
