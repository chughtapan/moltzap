/** @file Controlled network endpoints and their run-scoped Effect service. */

import type { ConversationId, HarnessTurn, StartInput } from "@moltzap/client";
import { Context, Effect, type Stream } from "effect";
import type { ParticipantHandle } from "./participant.js";
import type { AttachedEndpoint, EndpointTransport } from "./router.js";
import {
  type ConversationAddress,
  type ConversationSocket,
  makeConversationSocket,
} from "./conversation.js";
import { type NetworkError, networkError } from "./failure.js";

const endpointTypeId: unique symbol = Symbol("@moltzap/simulator/Endpoint");
const endpointConstruction: unique symbol = Symbol(
  "@moltzap/simulator/EndpointConstruction",
);

/** Run-scoped receive cursors maintained by the simulator kernel. */
export interface EndpointInbox {
  /** Live fan-out stream for observers of every endpoint turn. */
  readonly messages: Stream.Stream<HarnessTurn, NetworkError>;
  /** Obtain the shared ordered cursor for one bound conversation. */
  readonly conversation: (
    conversationId: ConversationId,
  ) => Effect.Effect<Stream.Stream<HarnessTurn, NetworkError>>;
}

/** A run-scoped participant controlled directly by the experiment program. */
export class Endpoint<Name extends string = string> {
  readonly [endpointTypeId] = endpointTypeId;

  readonly participant: ParticipantHandle<Name>;
  private readonly inbox: EndpointInbox;
  private readonly transport: EndpointTransport;

  private constructor(
    participant: ParticipantHandle<Name>,
    transport: EndpointTransport,
    inbox: EndpointInbox,
  ) {
    this.participant = participant;
    this.transport = transport;
    this.inbox = inbox;
  }

  static [endpointConstruction]<const Name extends string>(
    attachment: AttachedEndpoint<Name>,
    inbox: EndpointInbox,
  ): Endpoint<Name> {
    return new Endpoint(attachment.participant, attachment.transport, inbox);
  }

  /**
   * Start one conversation through this endpoint's semantic daemon client.
   * @param input Caller-minted conversation identity, peers, and initial content.
   * @returns Completion after the daemon accepts the semantic START.
   */
  start(input: StartInput): Effect.Effect<void, NetworkError> {
    return this.transport.start(input);
  }

  /**
   * Observe semantic turns delivered after this stream is subscribed.
   * @returns A live fan-out stream of turns for this endpoint.
   */
  messages(): Stream.Stream<HarnessTurn, NetworkError> {
    return this.inbox.messages;
  }

  /**
   * Bind this endpoint as the receiver for an existing address.
   * @param address Conversation whose participant set includes this endpoint.
   * @returns The endpoint-bound socket or a typed address mismatch.
   */
  socket(
    address: ConversationAddress,
  ): Effect.Effect<ConversationSocket, NetworkError> {
    const isParticipant = address.participants.some(
      (participant) => participant.id === this.participant.id,
    );
    return isParticipant
      ? this.inbox
          .conversation(address.conversationId)
          .pipe(
            Effect.map((messages) =>
              makeConversationSocket(this.participant, address, messages),
            ),
          )
      : Effect.fail(
          networkError(
            "socket",
            `participant ${this.participant.name} is not addressed by the conversation`,
          ),
        );
  }
}

/**
 * Construct a controlled endpoint from one ready attachment and its inbox.
 * @param attachment Ready participant and semantic daemon transport.
 * @param inbox Run-owned endpoint and conversation turn streams.
 * @returns The immutable controlled endpoint capability.
 */
export function makeEndpoint<const Name extends string>(
  attachment: AttachedEndpoint<Name>,
  inbox: EndpointInbox,
): Endpoint<Name> {
  const endpoint = Endpoint[endpointConstruction](attachment, inbox);
  Object.freeze(endpoint);
  return endpoint;
}

/** Controlled endpoint operations installed for one run scope. */
export interface NetworkService {
  endpoint<const Name extends string>(
    name: Name,
  ): Effect.Effect<Endpoint<Name>, NetworkError>;
}

/** Network operations available to the customer program. */
export class Network extends Context.Tag("@moltzap/simulator/Network")<
  Network,
  NetworkService
>() {}
