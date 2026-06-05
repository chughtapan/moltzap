import { Either, Schema, type Brand } from "effect";
import {
  stringEnum,
  dateTimeStringSchema,
  formatString,
} from "../transport/wire-string.js";
import { AgentKey, InviteCode } from "../credentials.js";
import { ListLimitSchema, listCursorSchema } from "../transport/pagination.js";
import { defineRpc } from "../transport/method.js";
import { AgentPrincipal, AgentClaimed } from "../transport/principal.js";
import { ConflictError, InvalidParamsError } from "../transport/wire-errors.js";

// ═══════════════════════════════════════════════════════════════════
// SHARED — agent identity value types used by 2+ blocks in this file.
//
// `AgentCardSchema` is the public agent card returned by `agents/lookup`,
// `agents/lookupByName`, and `agents/list`; `AgentSchema` is the full record
// it omits `createdAt` from. The brand IDs and strict guards are the trust
// boundary for records read from storage and registration.
// ═══════════════════════════════════════════════════════════════════

const DateTimeString = dateTimeStringSchema();

/** Optional supplemental wire fields every domain tagged-error carries. */
const errorPayloadFields = {
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
} as const;

/**
 * A referenced agent id does not resolve to an agent row. Raised wire-side when
 * a `participants` / `invitedAgentIds` target names an agent that does not
 * exist. Client-side name lookups use the same tagged error with a message/data
 * payload describing the missing name.
 */
export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFound",
  errorPayloadFields,
) {
  static readonly message = "Agent not found";
}

export type UserId = string & Brand.Brand<"UserId">;
export const UserId: Schema.Schema<UserId, string> = formatString("uuid").pipe(
  Schema.brand("UserId"),
  Schema.annotations({ description: "Branded UserId" }),
);
export type AgentId = string & Brand.Brand<"AgentId">;
export const AgentId: Schema.Schema<AgentId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("AgentId"),
  Schema.annotations({ description: "Branded AgentId" }),
);

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
  status: stringEnum(["active", "suspended"]),
  createdAt: DateTimeString,
});

const AgentCardSchema = AgentSchema.omit("createdAt");

const AgentOwnershipSchema = Schema.Struct({
  agentId: AgentId,
  ownerUserId: UserId,
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

// ═══════════════════════════════════════════════════════════════════
// agents/register (HTTP-only)
//
// Served over `http-routes.ts`, never WS-dispatched, so it carries no
// principal requirement (`requires: []`). The `paramsSchema` is the HTTP body
// schema.
// ═══════════════════════════════════════════════════════════════════

/**
 * Register a new agent and receive an API key.
 * @returns Agent ID and API key.
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
    inviteCode: Schema.optional(InviteCode),
  }),
  result: Schema.Struct({
    agentId: AgentId,
    apiKey: AgentKey,
  }),
  requires: [],
  errors: [ConflictError],
});

// ═══════════════════════════════════════════════════════════════════
// agents/lookup
// ═══════════════════════════════════════════════════════════════════

/**
 * Look up agents by their UUIDs. Returns agent cards for found agents.
 *
 * - **Principal:** `AgentPrincipal` head (no claimed refinement).
 */
export const AgentsLookup = defineRpc({
  name: "agents/lookup",
  params: Schema.Struct({
    agentIds: Schema.Array(AgentId).pipe(
      Schema.minItems(1),
      Schema.maxItems(100),
    ),
  }),
  result: Schema.Struct({ agents: Schema.Array(AgentCardSchema) }),
  requires: [AgentPrincipal],
  errors: [],
});

// ═══════════════════════════════════════════════════════════════════
// agents/lookupByName
// ═══════════════════════════════════════════════════════════════════

/**
 * Look up agents by their short names.
 *
 * - **Principal:** `AgentPrincipal` head (no claimed refinement).
 */
export const AgentsLookupByName = defineRpc({
  name: "agents/lookupByName",
  params: Schema.Struct({
    names: Schema.Array(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32)),
    ).pipe(Schema.minItems(1), Schema.maxItems(100)),
  }),
  result: Schema.Struct({ agents: Schema.Array(AgentCardSchema) }),
  requires: [AgentPrincipal],
  errors: [],
});

// ═══════════════════════════════════════════════════════════════════
// agents/list
// ═══════════════════════════════════════════════════════════════════

/**
 * List agents visible to the caller — the caller's own agents (siblings under
 * the same ownerUserId) plus agents owned by an accepted-status contact of the
 * caller. Unclaimed callers see only themselves.
 *
 * - **Principal:** `AgentPrincipal` head + `AgentClaimed` (claimed/active agent).
 * @error InvalidParamsError when the `cursor` does not decode
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
  requires: [AgentPrincipal, AgentClaimed],
  errors: [InvalidParamsError],
});
