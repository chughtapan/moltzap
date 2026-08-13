/** @file Private MCP representation for the semantic HarnessClient boundary. */

import {
  AgentCard,
  AgentName,
  Ed25519PublicKey,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { Effect, JSONSchema, Schema } from "effect";
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

const encodedAgentCardSchema = Schema.encodedSchema(AgentCard);

/** One certified action plus separately live private reply authority. */
const harnessTurnEventSchema = Schema.Struct({
  conversationId: ConversationId,
  peers: Schema.NonEmptyArray(encodedAgentCardSchema),
  author: encodedAgentCardSchema,
  content: contentSchema,
  replyGrant: Schema.String.pipe(Schema.minLength(1)),
});

/** START carries all public intent and its pre-minted identity. */
const harnessStartInputSchema = Schema.Struct({
  conversationId: ConversationId,
  peers: Schema.NonEmptyArray(AgentName),
  content: contentSchema,
});

/** Reply content is public while routing authority remains in request metadata. */
const harnessReplyInputSchema = Schema.Struct({ content: contentSchema });

const emptyResultSchema = Schema.Struct({});

/** Private route nested under the harness extension key in request metadata. */
const harnessReplyRouteSchema = Schema.Struct({
  replyGrant: Schema.String.pipe(Schema.minLength(1)),
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
  readonly replyGrant: string;
}

/** Decoded START arguments. */
export type HarnessStartInput = Schema.Schema.Type<
  typeof harnessStartInputSchema
>;

/** Decoded reply arguments. */
export type HarnessReplyInput = Schema.Schema.Type<
  typeof harnessReplyInputSchema
>;

/** Both mutating tools return no semantic result. */
export type HarnessEmptyResult = Schema.Schema.Type<typeof emptyResultSchema>;

const decodeTurnEvent = Schema.decodeUnknown(harnessTurnEventSchema);
const decodeReplyRoute = Schema.decodeUnknown(harnessReplyRouteSchema);
const decodeExtension = Schema.decodeUnknown(harnessExtensionSchema);

/** JSON Schema advertised for START arguments. */
export const harnessStartInputJsonSchema = JSONSchema.make(
  harnessStartInputSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for content-only reply arguments. */
export const harnessReplyInputJsonSchema = JSONSchema.make(
  harnessReplyInputSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for the empty mutating-tool result. */
export const harnessEmptyResultJsonSchema = JSONSchema.make(emptyResultSchema, {
  target: "jsonSchema2020-12",
});

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
  replyGrant: string,
): Readonly<Record<string, unknown>> => ({
  [HARNESS_EVENTS_EXTENSION]: { replyGrant },
});

const isUnknownRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Decode private reply authority while allowing unrelated MCP metadata.
 * @param requestMeta Untrusted request metadata.
 * @returns The strictly decoded private reply route.
 */
export const decodeHarnessReplyRoute = (requestMeta: unknown) => {
  const extensionValue: unknown = isUnknownRecord(requestMeta)
    ? requestMeta[HARNESS_EVENTS_EXTENSION]
    : undefined;
  return decodeReplyRoute(extensionValue, exact);
};

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
