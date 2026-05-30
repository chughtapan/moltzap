/**
 * @file Effect-Schema PROTOTYPE for the #723 wire-validation migration.
 *
 * THROWAWAY SPIKE CODE — bench-only. Not on any barrel, not imported by
 * production. It exists to A/B the per-frame decode cost of `effect/Schema`
 * (AST-interpreted) against the shipping TypeBox+AJV (compiled) path, in the
 * EXACT shape #723 would ship per the #720 spike verdict:
 *
 *   - one `Schema.Struct` per wire method, discriminated on the `method`
 *     literal (the migration's `Match.discriminator("method")` ground), with
 *     the same `jsonrpc`/`id`/`method`/`params` envelope the real
 *     `RequestFrameSchema` carries;
 *   - all ~34 server-inbound methods folded into one `Schema.Union` so the
 *     union arm-select cost matches the real catalog the AJV `.find()` scans;
 *   - decoded via `Schema.decodeUnknownEither(Union, { onExcessProperty:
 *     "error" })` — `onExcessProperty: "error"` is REQUIRED to match the
 *     shipping `new Ajv({ strict: true })` + `additionalProperties: false`,
 *     which rejects excess keys everywhere (effect's default silently STRIPS
 *     them — see #723 plan revision r4 B1).
 *
 * The three representative methods (`agents/list`, `messages/send`,
 * `task/conversation/create`) carry their FULL production param shapes,
 * including branded-UUID `Schema.pattern(UUID_RE)` fields (mirroring the
 * AJV `format: "uuid"` FormatRegistry check) and the nested text-part /
 * participants arrays. The remaining catalog methods carry a minimal params
 * struct: their param SHAPE does not affect the measured frames, but their
 * PRESENCE in the union is what makes the arm-select cost realistic.
 */
import { Schema } from "effect";
import type { Either } from "effect";

// Same UUID regex the production `schema-primitives.ts` FormatRegistry uses.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BrandedId = (brand: string) =>
  Schema.String.pipe(Schema.pattern(UUID_RE), Schema.brand(brand));

const TaskId = BrandedId("TaskId");
const ConversationId = BrandedId("ConversationId");
const MessageId = BrandedId("MessageId");
const AgentId = BrandedId("AgentId");
const LeaseId = BrandedId("LeaseId");

// ── Representative param shapes (full fidelity to production) ─────────

// `agents/list` — ListLimitSchema (optional int 1..200) + optional cursor.
const AgentsListParams = Schema.Struct({
  limit: Schema.optional(
    Schema.Int.pipe(
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(200),
    ),
  ),
  cursor: Schema.optional(Schema.String),
});

// `messages/send` — MessagePartsSchema is a union of text/image/file parts;
// the bench frame uses a text part, so the prototype mirrors the text arm
// (the discriminated part-union cost is part of params decode for this
// method, same as AJV runs the `PartSchema` union per element).
const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32768)),
});
const ImagePart = Schema.Struct({
  type: Schema.Literal("image"),
  url: Schema.String.pipe(Schema.minLength(1)),
  altText: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
});
const FilePart = Schema.Struct({
  type: Schema.Literal("file"),
  url: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  mimeType: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  ),
  size: Schema.optional(Schema.Int.pipe(Schema.greaterThanOrEqualTo(0))),
});
const PartSchema = Schema.Union(TextPart, ImagePart, FilePart);
const MessagesSendParams = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  parts: Schema.Array(PartSchema).pipe(Schema.minItems(1), Schema.maxItems(10)),
  replyToId: Schema.optional(MessageId),
  dispatchLeaseId: Schema.optional(LeaseId),
});

// `task/conversation/create` — branded UUID + participants[] of UUIDs.
const TaskConversationCreateParams = Schema.Struct({
  taskId: TaskId,
  name: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  ),
  participants: Schema.Array(AgentId).pipe(Schema.minItems(1)),
});

// Minimal filler params for the non-measured catalog methods — present so
// the union arm count matches the real ~34-method `serverRpcMethods`.
const FillerParams = Schema.Struct({});

// One frame schema per method, discriminated on the `method` literal.
const frame = <P extends Schema.Schema.AnyNoContext>(
  method: string,
  params: P,
) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.String,
    method: Schema.Literal(method),
    params,
  });

// The remaining server-inbound RPC methods — exactly the 28 names in the
// real `serverRpcMethods` catalog MINUS the 3 modeled in full above, so the
// union has the same 31 arms `serverRpcMethods` has (verified against
// `serverRpcMethods.map(d => d.name)` at the base tree). They carry filler
// params: their SHAPE does not affect the measured frames, but their
// PRESENCE is what makes the discriminated-union arm-select cost realistic.
// If a method is added to / removed from the wire, this list drifts from the
// real catalog by one arm — a tolerable bench-fidelity rounding, not a
// correctness bug (the AJV side always scans the live `serverRpcMethods`).
const FILLER_METHODS = [
  "agents/claim",
  "agents/invite",
  "agents/lookup",
  "agents/lookupByName",
  "agents/register",
  "apps/register",
  "contacts/accept",
  "contacts/add",
  "contacts/byId",
  "contacts/list",
  "dispatch/request",
  "dispatches/get",
  "invites/createAgent",
  "messages/list",
  "network/connect",
  "network/ping",
  "presence/subscribe",
  "task/addParticipant",
  "task/close",
  "task/conversation/archive",
  "task/conversation/list",
  "task/conversation/participants/add",
  "task/conversation/participants/remove",
  "task/conversation/unarchive",
  "task/leave",
  "task/list",
  "task/removeParticipant",
  "task/request",
] as const;

const fillerFrames = FILLER_METHODS.map((m) => frame(m, FillerParams));

/**
 * The discriminated `WireFrame` union — the migration's
 * `Schema.Union(...perMethodStructs)`. Arm count == real catalog size (31) so
 * the decode pays a representative discriminator-narrow + params-decode.
 */
const WireRequestUnion = Schema.Union(
  frame("agents/list", AgentsListParams),
  frame("messages/send", MessagesSendParams),
  frame("task/conversation/create", TaskConversationCreateParams),
  ...fillerFrames,
);

/**
 * Number of arms in the prototype union (3 fully-modeled + the fillers).
 * The sibling `frames.test.ts` asserts this equals the live
 * `serverRpcMethods` catalog size so the method-selection cost stays a fair
 * A/B — if the wire gains/loses a method, the test fails and the filler list
 * gets re-synced before the bench numbers are trusted again.
 */
export const PROTOTYPE_UNION_ARM_COUNT = 3 + fillerFrames.length;

// `onExcessProperty: "error"` to match AJV strict + additionalProperties:false.
const decoder = Schema.decodeUnknownEither(WireRequestUnion, {
  onExcessProperty: "error",
});

/**
 * Full inbound decode in ONE pass: the union decode subsumes the AJV
 * `decodeFrame` 3-arm envelope classify AND the `decodeRpcRequest` linear
 * `.find()` method-select AND the per-method params validation.
 */
export function decodeWireRequest(
  frameValue: unknown,
): Either.Either<unknown, unknown> {
  return decoder(frameValue);
}

/**
 * Method-selection isolation: the same union decode. Effect has no separate
 * "select arm then validate params" stage — the discriminated-union decode
 * does both in one walk, so this is identical to `decodeWireRequest`. Kept as
 * a named entry to mirror the AJV `selectAjvMethod` measurement.
 */
export function selectMethodArm(frameValue: unknown): void {
  decoder(frameValue);
}
