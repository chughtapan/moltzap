/**
 * @file The public Client remains a two-member structural capability whose
 * turns contain one semantic action and whose bound reply accepts content
 * only. These canaries prevent transitional service and protocol fields from
 * returning through structural widening.
 */

import type { Effect, Scope, Stream } from "effect";
import type {
  acquireHarnessClient,
  AgentName,
  ConnectError,
  Content,
  ConversationId,
  ConversationIdGenerationError,
  createConversationId,
  HarnessClient,
  HarnessTurn,
  ListenError,
  ReplyError,
  StartError,
  StartInput,
  VerifiedAgentCard,
} from "./index.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type ExpectedStart = Readonly<{
  conversationId: ConversationId;
  peers: readonly [AgentName, ...AgentName[]];
  content: Content;
}>;
type ExpectedTurn = Readonly<{
  conversationId: ConversationId;
  peers: readonly [VerifiedAgentCard, ...VerifiedAgentCard[]];
  author: VerifiedAgentCard;
  content: Content;
  reply: (content: Content) => Effect.Effect<void, ReplyError>;
}>;
type ExpectedClient = Readonly<{
  start: (input: StartInput) => Effect.Effect<void, StartError>;
  turns: Stream.Stream<HarnessTurn, ListenError>;
}>;

type StartIsExact = Expect<Equal<StartInput, ExpectedStart>>;
type TurnIsExact = Expect<Equal<HarnessTurn, ExpectedTurn>>;
type ClientIsExact = Expect<Equal<HarnessClient, ExpectedClient>>;
type IdCreationIsEffect = Expect<
  Equal<
    ReturnType<typeof createConversationId>,
    Effect.Effect<ConversationId, ConversationIdGenerationError>
  >
>;
type AcquisitionIsScoped = Expect<
  Equal<Parameters<typeof acquireHarnessClient>, [endpoint: URL]>
>;
type AcquisitionResultIsExact = Expect<
  Equal<
    ReturnType<typeof acquireHarnessClient>,
    Effect.Effect<HarnessClient, ConnectError, Scope.Scope>
  >
>;
/** Compile-time witnesses for the accepted public Client boundary. */
export type HarnessClientCanaries = [
  StartIsExact,
  TurnIsExact,
  ClientIsExact,
  IdCreationIsEffect,
  AcquisitionIsScoped,
  AcquisitionResultIsExact,
];
