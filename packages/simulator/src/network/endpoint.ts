/** @file Controlled network endpoints and their run-scoped Effect service. */

import { Context, Effect, type Stream } from "effect";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  type ConversationAddress,
  type ConversationSocket,
  makeConversationAddress,
  makeConversationSocket,
  type ConversationParticipants,
} from "./conversation.js";
import type { ParticipantHandle } from "./participant.js";
import type {
  AttachedEndpoint,
  EndpointTransport,
  ParticipantIds,
  ReceivedMessage,
} from "./router.js";
import { type NetworkError, networkError } from "./failure.js";

const endpointTypeId: unique symbol = Symbol("@moltzap/simulator/Endpoint");
const endpointConstruction: unique symbol = Symbol(
  "@moltzap/simulator/EndpointConstruction",
);

/** Run-scoped receive cursors maintained by the simulator kernel. */
export interface EndpointInbox {
  /** Live fan-out stream for observers of every endpoint delivery. */
  readonly messages: Stream.Stream<ReceivedMessage, NetworkError>;
  /** Obtain the shared ordered cursor for one bound conversation. */
  readonly conversation: (
    conversationId: ConversationId,
  ) => Effect.Effect<Stream.Stream<ReceivedMessage, NetworkError>>;
}

function addressedParticipants(
  endpoint: ParticipantHandle,
  participants: ConversationParticipants,
): ConversationParticipants {
  const ids = new Set<AgentId>([endpoint.id]);
  const unique: ParticipantHandle[] = [];
  for (const participant of participants) {
    if (!ids.has(participant.id)) {
      ids.add(participant.id);
      unique.push(participant);
    }
  }
  return Object.freeze([endpoint, ...unique]);
}

/** A run-scoped participant controlled directly by the experiment program. */
export class Endpoint<Name extends string = string> {
  readonly [endpointTypeId] = endpointTypeId;

  readonly participant: ParticipantHandle<Name>;
  private readonly transport: EndpointTransport;
  private readonly inbox: EndpointInbox;

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
   * Observe messages delivered after this stream is subscribed. Conversation
   * sockets retain their own ordered delivery queues independently.
   * @returns Live endpoint delivery stream.
   */
  messages(): Stream.Stream<ReceivedMessage, NetworkError> {
    return this.inbox.messages;
  }

  /**
   * Open a conversation through this endpoint's ordinary protocol attachment.
   * The opener is included in the resulting address automatically.
   * @param participants Nonempty addressed participant set.
   * @returns A conversation socket bound to this endpoint.
   */
  open(
    ...participants: ConversationParticipants
  ): Effect.Effect<ConversationSocket, NetworkError> {
    const [first, ...rest] = participants;
    const ids: ParticipantIds = [
      first.id,
      ...rest.map((participant) => participant.id),
    ];
    const addressed = addressedParticipants(this.participant, participants);
    return this.transport.openConversation(ids).pipe(
      Effect.flatMap((opened) =>
        this.inbox.conversation(opened.conversationId).pipe(
          Effect.map((messages) => ({
            messages,
            opened,
          })),
        ),
      ),
      Effect.map(({ messages, opened }) => {
        const address = makeConversationAddress(
          opened.conversationId,
          addressed,
        );
        return makeConversationSocket(
          this.participant,
          address,
          messages,
          (content) => this.transport.send(address.conversationId, content),
        );
      }),
    );
  }

  /**
   * Bind this endpoint as the sender for an existing address.
   * @param address Participant-independent conversation address.
   * @returns Endpoint-bound socket when this endpoint is addressed.
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
              makeConversationSocket(
                this.participant,
                address,
                messages,
                (content) =>
                  this.transport.send(address.conversationId, content),
              ),
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
 * Construct a controlled endpoint from one ready router attachment and its
 * kernel-owned inbox.
 * @param attachment Ready scope-owned endpoint attachment.
 * @param inbox Ordered endpoint and conversation receive cursors.
 * @returns Controlled experiment endpoint.
 * @internal
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
