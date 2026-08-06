/** @file Router acquisition, attachment, and evidence ports. */

import {
  type ConversationId,
  conversationId,
  messageId,
} from "@moltzap/protocol/conversation";
import {
  type AgentId,
  agentId,
  type AgentKey,
  type AgentName,
} from "@moltzap/protocol/identity";
import type { Message, MessageParts } from "@moltzap/protocol/message";
import type { ServerBaseUrl } from "@moltzap/protocol/network";
import {
  type Brand,
  Context,
  type Effect,
  Schema,
  type Scope,
  type Stream,
} from "effect";
import type { AgentHandle, ParticipantHandle } from "./participant.js";
import type { NetworkError } from "./failure.js";

const routerStoppedTypeId: unique symbol = Symbol(
  "@moltzap/simulator/RouterStopped",
);
const routerStoppedConstruction: unique symbol = Symbol(
  "@moltzap/simulator/RouterStoppedConstruction",
);

/** A message delivered to one attached endpoint. */
export interface ReceivedMessage {
  readonly message: Message;
}

/** Conversation identity returned by an endpoint transport. */
export interface OpenedConversation {
  readonly conversationId: ConversationId;
}

/** Nonempty participant identities passed over the protocol. */
export type ParticipantIds = readonly [AgentId, ...(readonly AgentId[])];

/** Re-exports the public API from `@moltzap/protocol/message`. */
export type { MessageParts } from "@moltzap/protocol/message";

/** Router-local order assigned when a message becomes durable. */
export type RouterSequence = number & Brand.Brand<"RouterSequence">;
/** Validated router-local durable-message order. */
const routerSequenceSchema: Schema.Schema<RouterSequence, number> =
  Schema.NonNegativeInt.pipe(Schema.brand("RouterSequence"));
/** Construct a validated router sequence in router implementations and tests. */
export const routerSequence = Schema.decodeSync(routerSequenceSchema);

/**
 * A ready, scope-owned data-plane attachment. Acquisition owns connection and
 * teardown, so consumers cannot observe or drive a separate connect state.
 * The receive ingress is subscribed before acquisition returns and retains
 * deliveries until the kernel's single consumer advances the Stream.
 */
export interface EndpointTransport {
  readonly received: Stream.Stream<ReceivedMessage, NetworkError>;
  openConversation(
    participants: ParticipantIds,
  ): Effect.Effect<OpenedConversation, NetworkError>;
  send(
    conversationId: ConversationId,
    parts: MessageParts,
  ): Effect.Effect<Message, NetworkError>;
}

/**
 * Runtime connection issued by every router implementation. It carries the
 * credential and address a runtime dials; each runtime chooses its own startup
 * deadline and owns whatever readiness evidence its process exposes.
 */
export interface AgentConnection<Name extends string = string> {
  readonly agent: AgentHandle<Name>;
  readonly key: AgentKey;
  readonly routerUrl: ServerBaseUrl;
}

/** Router output used by an experiment-controlled endpoint. */
export interface AttachedEndpoint<Name extends string> {
  readonly participant: ParticipantHandle<Name>;
  readonly transport: EndpointTransport;
}

/** Content-blind projection of one durable router commit. */
export class CommittedRouterMessage extends Schema.Class<CommittedRouterMessage>(
  "CommittedRouterMessage",
)({
  conversationId: conversationId,
  messageId: messageId,
  senderId: agentId,
  routerSequence: routerSequenceSchema,
}) {}

/**
 * Shutdown evidence available only after the router scope has released.
 * Platform implementations complete `Router.stopped` with this stop report.
 */
export class RouterStopped {
  readonly [routerStoppedTypeId] = routerStoppedTypeId;

  readonly committedMessages: readonly CommittedRouterMessage[];

  private constructor(committedMessages: readonly CommittedRouterMessage[]) {
    this.committedMessages = committedMessages;
  }

  static [routerStoppedConstruction](
    committedMessages: readonly CommittedRouterMessage[],
  ): RouterStopped {
    return new RouterStopped(committedMessages);
  }
}

/**
 * Construct a stop report at a platform boundary.
 * @param committedMessages Durable-message evidence.
 * @returns Nominal router stop report.
 */
export function makeRouterStopReport(
  committedMessages: readonly CommittedRouterMessage[],
): RouterStopped {
  return Object.freeze(
    RouterStopped[routerStoppedConstruction](
      Object.freeze([...committedMessages]),
    ),
  );
}

/**
 * Run-scoped router port. It exposes protocol connections and shutdown
 * evidence, never concrete clients or storage.
 */
export interface Router {
  readonly address: ServerBaseUrl;

  /**
   * Awaits the stop report completed by scoped release. The owning scope
   * controls shutdown and makes the report available.
   */
  readonly stopped: Effect.Effect<RouterStopped, NetworkError>;

  attachAgent<const Name extends string>(
    name: Name,
    agentName: AgentName,
  ): Effect.Effect<AgentConnection<Name>, NetworkError, Scope.Scope>;

  attachEndpoint<const Name extends string>(
    name: Name,
    agentName: AgentName,
  ): Effect.Effect<AttachedEndpoint<Name>, NetworkError, Scope.Scope>;
}

/** Router acquisition service supplied by the platform Layer. */
export interface RouterProviderService {
  readonly acquire: Effect.Effect<Router, NetworkError, Scope.Scope>;
}

/** Router acquisition service supplied by the platform Layer. */
export class RouterProvider extends Context.Tag(
  "@moltzap/simulator/RouterProvider",
)<RouterProvider, RouterProviderService>() {}
