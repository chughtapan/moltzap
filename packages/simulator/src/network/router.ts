/** @file Router acquisition, attachment, and evidence ports. */

import { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import {
  AgentId,
  type AgentKey,
  type AgentName,
} from "@moltzap/protocol/identity";
import type { Message, MessageParts } from "@moltzap/protocol/message";
import type { ServerBaseUrl } from "@moltzap/protocol/network";
import { TaskId } from "@moltzap/protocol/task";
import {
  type Brand,
  Context,
  type Duration,
  Effect,
  Schema,
  type Scope,
  Stream,
} from "effect";
import type { AgentHandle, ParticipantHandle } from "./participant.js";

const RouterStoppedTypeId: unique symbol = Symbol(
  "@moltzap/simulator/RouterStopped",
);
const RouterStoppedConstruction: unique symbol = Symbol(
  "@moltzap/simulator/RouterStoppedConstruction",
);

const NetworkOperation = Schema.Literal(
  "acquire-router",
  "attach-agent",
  "attach-endpoint",
  "disable-link",
  "enable-link",
  "open-conversation",
  "receive",
  "socket",
  "stop-router",
  "send",
);
/** Network operation names used by typed failures. */
export type NetworkOperation = typeof NetworkOperation.Type;

/** An operational failure at a network boundary. */
export class NetworkFailure extends Schema.TaggedError<NetworkFailure>()(
  "NetworkFailure",
  {
    operation: NetworkOperation,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Network ${this.operation} failed: ${this.detail}`;
  }
}

/**
 * Normalize an implementation failure at the network boundary.
 * @param operation Failed network operation.
 * @param cause Implementation failure.
 * @returns Typed network failure.
 */
export function networkFailure(
  operation: NetworkOperation,
  cause: unknown,
): NetworkFailure {
  return NetworkFailure.make({ operation, detail: String(cause) });
}

/** A message delivered to one attached endpoint. */
export interface ReceivedMessage {
  readonly taskId: TaskId;
  readonly message: Message;
}

/** Conversation identity returned by an endpoint transport. */
export interface OpenedConversation {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

/** Nonempty participant identities passed over the protocol. */
export type ParticipantIds = readonly [AgentId, ...ReadonlyArray<AgentId>];

export type { MessageParts } from "@moltzap/protocol/message";

/** Router-local order assigned when a message becomes durable. */
export type RouterSequence = number & Brand.Brand<"RouterSequence">;
/** Validated router-local durable-message order. */
export const RouterSequence: Schema.Schema<RouterSequence, number> =
  Schema.NonNegativeInt.pipe(Schema.brand("RouterSequence"));
/** Construct a validated router sequence in router implementations and tests. */
export const routerSequence = Schema.decodeSync(RouterSequence);

/**
 * A ready, scope-owned data-plane attachment. Acquisition owns connection and
 * teardown, so consumers cannot observe or drive a separate connect state.
 * The receive ingress is subscribed before acquisition returns and retains
 * deliveries until the kernel's single consumer advances the Stream.
 */
export interface EndpointTransport {
  readonly received: Stream.Stream<ReceivedMessage, NetworkFailure>;
  openConversation(
    participants: ParticipantIds,
  ): Effect.Effect<OpenedConversation, NetworkFailure>;
  send(
    taskId: TaskId,
    conversationId: ConversationId,
    parts: MessageParts,
  ): Effect.Effect<Message, NetworkFailure>;
}

/**
 * Runtime connection issued by every router implementation. A
 * runtime chooses its own startup deadline and awaits router-visible readiness
 * before completing acquisition.
 */
export interface AgentConnection<Name extends string = string> {
  readonly agent: AgentHandle<Name>;
  readonly key: AgentKey;
  readonly routerUrl: ServerBaseUrl;
  awaitReady(within: Duration.Duration): Effect.Effect<void, NetworkFailure>;
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
  taskId: TaskId,
  conversationId: ConversationId,
  messageId: MessageId,
  senderId: AgentId,
  routerSequence: RouterSequence,
}) {}

/**
 * Shutdown evidence available only after the router scope has released.
 * Platform implementations complete `Router.stopped` with this stop report.
 */
export class RouterStopped {
  readonly [RouterStoppedTypeId] = RouterStoppedTypeId;

  private constructor(
    readonly committedMessages: ReadonlyArray<CommittedRouterMessage>,
  ) {}

  static [RouterStoppedConstruction](
    committedMessages: ReadonlyArray<CommittedRouterMessage>,
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
  committedMessages: ReadonlyArray<CommittedRouterMessage>,
): RouterStopped {
  return Object.freeze(
    RouterStopped[RouterStoppedConstruction](
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
  readonly stopped: Effect.Effect<RouterStopped, NetworkFailure>;

  attachAgent<const Name extends string>(
    name: Name,
    agentName: AgentName,
  ): Effect.Effect<AgentConnection<Name>, NetworkFailure, Scope.Scope>;

  attachEndpoint<const Name extends string>(
    name: Name,
    agentName: AgentName,
  ): Effect.Effect<AttachedEndpoint<Name>, NetworkFailure, Scope.Scope>;
}

/** Router acquisition service supplied by the platform Layer. */
export interface RouterProviderService {
  readonly acquire: Effect.Effect<Router, NetworkFailure, Scope.Scope>;
}

/** Router acquisition service supplied by the platform Layer. */
export class RouterProvider extends Context.Tag(
  "@moltzap/simulator/RouterProvider",
)<RouterProvider, RouterProviderService>() {}
