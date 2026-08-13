/** @file Public runtime capability for one configured MoltZap endpoint. */

import type { AgentName, VerifiedAgentCard } from "@moltzap/identity";
import { Data, Effect, Schema, type Stream } from "effect";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the nominal values they decode. */

/* eslint-disable agent-code-guard/no-nullish-type-aliases -- JSON includes null as a first-class value. */
/** A value accepted by the closed semantic content boundary. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
/* eslint-enable agent-code-guard/no-nullish-type-aliases -- Restore the absence rule outside JSON values. */

/** One semantic part of a conversation action. */
export type ContentPart =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "data"; value: JsonValue }>;

/** Nonempty semantic content for one conversation action. */
export type Content = readonly [ContentPart, ...ContentPart[]];

/** Caller-retained identity for one conversation and its START retries. */
export const ConversationId = Schema.UUID.pipe(
  Schema.brand("ConversationId"),
  Schema.annotations({
    identifier: "ConversationId",
    description: "Caller-minted conversation identity",
  }),
);

/** Validated conversation identity. */
export type ConversationId = typeof ConversationId.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pair. */

/** Creating a conversation identity failed. */
export class ConversationIdGenerationError extends Data.TaggedError(
  "ConversationIdGenerationError",
) {}

type StartFailure =
  | "intent-conflict"
  | "not-registered"
  | "membership"
  | "persistence"
  | "durability"
  | "reanchor"
  | "representation";

/** Closed failure from one START operation. */
export class StartError extends Data.TaggedError("StartError")<{
  readonly reason: StartFailure;
}> {}

type ListenFailure = "connection" | "representation" | "subscription-in-use";

/** Closed failure from the endpoint's sole inbound stream. */
export class ListenError extends Data.TaggedError("ListenError")<{
  readonly reason: ListenFailure;
}> {}

type ReplyFailure =
  | "authority-unavailable"
  | "persistence"
  | "durability"
  | "reanchor"
  | "representation";

/** Closed failure from one turn-bound reply. */
export class ReplyError extends Data.TaggedError("ReplyError")<{
  readonly reason: ReplyFailure;
}> {}

/** Complete semantic input for a new conversation. */
export interface StartInput {
  readonly conversationId: ConversationId;
  readonly peers: readonly [AgentName, ...AgentName[]];
  readonly content: Content;
}

/** One certified current-conversation action with live reply authority. */
export interface HarnessTurn {
  readonly conversationId: ConversationId;
  readonly peers: readonly [VerifiedAgentCard, ...VerifiedAgentCard[]];
  readonly author: VerifiedAgentCard;
  readonly content: Content;
  readonly reply: (content: Content) => Effect.Effect<void, ReplyError>;
}

/** Structural runtime capability owned by one scoped endpoint connection. */
export interface HarnessClient {
  readonly start: (input: StartInput) => Effect.Effect<void, StartError>;
  readonly turns: Stream.Stream<HarnessTurn, ListenError>;
}

const generationFailure = (): ConversationIdGenerationError =>
  new ConversationIdGenerationError();

/**
 * Mint a ConversationId before any START network work begins.
 * @returns The newly minted caller-retained identity.
 */
export const createConversationId = (): Effect.Effect<
  ConversationId,
  ConversationIdGenerationError
> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(ConversationId)(crypto.randomUUID()),
    catch: generationFailure,
  });
