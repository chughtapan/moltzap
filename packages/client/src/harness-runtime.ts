/** @file Private MCP representation for the semantic HarnessClient boundary. */

import {
  AgentCard,
  AgentName,
  Ed25519PublicKey,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { Effect, Either, Encoding, JSONSchema, Schema } from "effect";
import { type Content, ConversationId, type JsonValue } from "./contract.js";

/** Harness MCP extension carrying the runtime event contract. */
export const HARNESS_EVENTS_EXTENSION = "xyz.moltzap/events-v1";

/** Subscription filter requesting reply-capable harness turns. */
export const HARNESS_TURN_READY_FILTER = "xyz.moltzap/turnReady";

/** Notification method carrying one semantic action and its live authority. */
export const HARNESS_TURN_READY_NOTIFICATION =
  "notifications/xyz.moltzap/turn_ready";

/** Tool that begins a conversation with caller-retained retry identity. */
export const HARNESS_START_TOOL = "start_conversation";

/** Tool used through authority captured by one live turn. */
export const HARNESS_REPLY_TOOL = "reply";

const exact = { onExcessProperty: "error" } as const;

const jsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.JsonNumber,
    Schema.String,
    Schema.Array(jsonValueSchema),
    Schema.Record({ key: Schema.String, value: jsonValueSchema }),
  ),
).annotations({ identifier: "HarnessJsonValue" });

const contentPartSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("data"), value: jsonValueSchema }),
);

const contentSchema: Schema.Schema<Content> =
  Schema.NonEmptyArray(contentPartSchema);

const hasCanonicalBase64UrlBytes = (
  value: string,
  byteLength: number,
): boolean =>
  Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => false,
    onRight: (bytes) =>
      bytes.length === byteLength && Encoding.encodeBase64Url(bytes) === value,
  });

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Private Effect Schema and decoded nominal value intentionally share one domain name. */
/** Opaque one-use live authority carried only by the private MCP wire. */
export const ReplyGrant = Schema.String.pipe(
  Schema.filter((value) => hasCanonicalBase64UrlBytes(value, 32), {
    message: () => "Expected a canonical unpadded base64url 256-bit grant",
  }),
  Schema.brand("ReplyGrant"),
);

/** Strictly decoded private reply authority. */
export type ReplyGrant = typeof ReplyGrant.Type;
/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore defaults after the private Schema/type pair. */

/** Exact raw MCP arguments for START. */
const harnessStartRequestSchema = Schema.Struct({
  conversationId: ConversationId,
  peers: Schema.NonEmptyArray(AgentName),
  content: contentSchema,
});

/** Exact raw MCP arguments for a turn-bound reply. */
const harnessReplyRequestSchema = Schema.Struct({
  content: contentSchema,
});

/** Exact empty structured success result for both model operations. */
const harnessEmptyResultSchema = Schema.Struct({});

/** Decoded START arguments owned by the daemon MCP boundary. */
export type HarnessStartRequest = typeof harnessStartRequestSchema.Type;

/** Decoded content-only reply arguments owned by the daemon MCP boundary. */
export type HarnessReplyRequest = typeof harnessReplyRequestSchema.Type;

/** Both mutating tools return one exact empty structured result. */
export type HarnessEmptyResult = typeof harnessEmptyResultSchema.Type;

/** JSON Schema advertised for exact START arguments. */
export const harnessStartRequestJsonSchema = JSONSchema.make(
  harnessStartRequestSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for exact content-only reply arguments. */
export const harnessReplyRequestJsonSchema = JSONSchema.make(
  harnessReplyRequestSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for an empty successful operation result. */
export const harnessEmptyResultJsonSchema = JSONSchema.make(
  harnessEmptyResultSchema,
  { target: "jsonSchema2020-12" },
);

const encodedAgentCardSchema = Schema.encodedSchema(AgentCard);

/** One certified action plus separately live private reply authority. */
const harnessTurnEventSchema = Schema.Struct({
  conversationId: ConversationId,
  peers: Schema.NonEmptyArray(encodedAgentCardSchema),
  author: encodedAgentCardSchema,
  content: contentSchema,
  replyGrant: ReplyGrant,
});

/** Deployment identity material advertised by the daemon, never the Client API. */
const harnessExtensionSchema = Schema.Struct({
  registrySignerPublicKey: Ed25519PublicKey,
});

/** Encoded complete-card event received from the loopback daemon. */
export type HarnessTurnEvent = Schema.Schema.Type<
  typeof harnessTurnEventSchema
>;

/** Verified semantic action ready for public projection. */
interface VerifiedHarnessTurnEvent {
  readonly conversationId: HarnessTurnEvent["conversationId"];
  readonly peers: readonly [VerifiedAgentCard, ...VerifiedAgentCard[]];
  readonly author: VerifiedAgentCard;
  readonly content: Content;
  readonly replyGrant: ReplyGrant;
}

const replyRequestMetaSchema = Schema.Struct({
  [HARNESS_EVENTS_EXTENSION]: Schema.Struct({ replyGrant: ReplyGrant }),
});

const decodeTurnEvent = Schema.decodeUnknown(harnessTurnEventSchema);
const decodeExtension = Schema.decodeUnknown(harnessExtensionSchema);

/**
 * Strictly decode one semantic turn event received from MCP.
 * @param value Untrusted notification parameters.
 * @returns The closed encoded action event.
 */
export const decodeHarnessTurnEvent = (value: unknown) =>
  decodeTurnEvent(value, exact);

/**
 * Build private request metadata from the live event's opaque authority.
 * @param replyGrant Opaque authority supplied by the live event.
 * @returns Namespaced MCP metadata containing only that authority.
 */
export const harnessReplyRequestMeta = (
  replyGrant: ReplyGrant,
): Readonly<Record<string, unknown>> => ({
  [HARNESS_EVENTS_EXTENSION]: { replyGrant },
});

/**
 * Strictly decode the sole private authority in reply request metadata.
 * @param value Untrusted MCP request metadata.
 * @returns The canonical one-use reply grant.
 */
export const decodeHarnessReplyRequestMeta = (value: unknown) =>
  Schema.decodeUnknown(replyRequestMetaSchema)(value, exact).pipe(
    Effect.map((metadata) => metadata[HARNESS_EVENTS_EXTENSION].replyGrant),
  );

/**
 * Strictly decode exact START arguments received by the daemon.
 * @param value Untrusted MCP tool arguments.
 * @returns The semantic START input.
 */
export const decodeHarnessStartRequest = (value: unknown) =>
  Schema.decodeUnknown(harnessStartRequestSchema)(value, exact);

/**
 * Strictly decode exact reply arguments received by the daemon.
 * @param value Untrusted MCP tool arguments.
 * @returns The content-only reply input.
 */
export const decodeHarnessReplyRequest = (value: unknown) =>
  Schema.decodeUnknown(harnessReplyRequestSchema)(value, exact);

/**
 * Mint fresh volatile authority for one admitted turn.
 * @returns A canonical 256-bit opaque grant.
 */
export const makeReplyGrant = (): Effect.Effect<ReplyGrant> =>
  Effect.sync(() => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Schema.decodeUnknownSync(ReplyGrant)(
      Encoding.encodeBase64Url(bytes),
    );
  });

const isUnknownRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Decode the daemon-pinned Registry signer from its advertised extension.
 * @param extensions Untrusted server extension declarations.
 * @returns The strictly decoded Registry verification key.
 */
export const decodeHarnessExtension = (extensions: unknown) => {
  const extensionValue: unknown = isUnknownRecord(extensions)
    ? extensions[HARNESS_EVENTS_EXTENSION]
    : undefined;
  return decodeExtension(extensionValue, exact);
};

/**
 * Verify every complete card before projecting a runtime turn.
 * @param event Closed but unverified action event.
 * @param registrySignerPublicKey Deployment-pinned Registry verification key.
 * @returns The event with Identity-verified cards.
 */
export const verifyHarnessTurnEvent = (
  event: HarnessTurnEvent,
  registrySignerPublicKey: typeof Ed25519PublicKey.Type,
) =>
  Effect.gen(function* () {
    const verifyRepresentation = (representation: unknown) =>
      Schema.decodeUnknown(AgentCard)(representation, exact).pipe(
        Effect.flatMap((agentCard) =>
          AgentCard.verify({ agentCard, registrySignerPublicKey }),
        ),
      );
    const author = yield* verifyRepresentation(event.author);
    const [firstPeerRepresentation, ...remainingPeerRepresentations] =
      event.peers;
    const firstPeer = yield* verifyRepresentation(firstPeerRepresentation);
    const remainingPeers = yield* Effect.forEach(
      remainingPeerRepresentations,
      verifyRepresentation,
      { concurrency: "inherit" },
    );
    return {
      conversationId: event.conversationId,
      peers: [firstPeer, ...remainingPeers],
      author,
      content: event.content,
      replyGrant: event.replyGrant,
    } satisfies VerifiedHarnessTurnEvent;
  }).pipe(Effect.withSpan("verifyHarnessTurnEvent"));
