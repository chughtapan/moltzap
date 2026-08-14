/** @file Participant-independent conversation addressing. */

import type { ConversationId, HarnessTurn } from "@moltzap/client";
import { Effect, Option, Stream } from "effect";
import type { ParticipantHandle } from "./participant.js";
import { type NetworkError, networkError } from "./failure.js";

const conversationAddressTypeId: unique symbol = Symbol(
  "@moltzap/simulator/ConversationAddress",
);
const conversationSocketTypeId: unique symbol = Symbol(
  "@moltzap/simulator/ConversationSocket",
);
const conversationSocketConstruction: unique symbol = Symbol(
  "@moltzap/simulator/ConversationSocketConstruction",
);

/** Every conversation has at least one participant of any network role. */
export type ConversationParticipants = readonly [
  ParticipantHandle,
  ...(readonly ParticipantHandle[]),
];

/**
 * A participant-independent network address. Binding an endpoint produces a
 * conversation socket; the address itself never implies a sender.
 */
export class ConversationAddress {
  readonly [conversationAddressTypeId] = conversationAddressTypeId;

  readonly conversationId: ConversationId;
  readonly participants: ConversationParticipants;

  constructor(
    conversationId: ConversationId,
    participants: ConversationParticipants,
  ) {
    if (participants.length === 0) {
      // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- This synchronous public constructor rejects invalid JavaScript input before creating a nominal address.
      throw new TypeError("conversation participants must not be empty");
    }
    const [first, ...rest] = participants;
    if (
      new Set(participants.map(({ id }) => id)).size !== participants.length
    ) {
      // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- This synchronous public constructor rejects invalid JavaScript input before creating a nominal address.
      throw new TypeError(
        "conversation participants must be unique by AgentId",
      );
    }
    this.conversationId = conversationId;
    this.participants = Object.freeze([first, ...rest]);
    Object.freeze(this);
  }
}

/**
 * Construct an address from one caller-minted conversation identity.
 * @param conversationId Identity minted before any network operation.
 * @param participants Nonempty, unique participant set for the conversation.
 * @returns The immutable participant-independent address.
 */
export function makeConversationAddress(
  conversationId: ConversationId,
  participants: ConversationParticipants,
): ConversationAddress {
  return new ConversationAddress(conversationId, participants);
}

/** A conversation address bound to exactly one controlled endpoint. */
// eslint-disable-next-line agent-code-guard/max-non-trivial-classes-per-file -- an address and its endpoint-bound socket are the two faces of one conversation capability
export class ConversationSocket {
  readonly [conversationSocketTypeId] = conversationSocketTypeId;

  /** Ordered semantic turns for this endpoint and conversation. */
  readonly messages: Stream.Stream<HarnessTurn, NetworkError>;

  readonly endpoint: ParticipantHandle;
  readonly address: ConversationAddress;

  private constructor(
    endpoint: ParticipantHandle,
    address: ConversationAddress,
    messages: Stream.Stream<HarnessTurn, NetworkError>,
  ) {
    this.endpoint = endpoint;
    this.address = address;
    this.messages = messages;
  }

  static [conversationSocketConstruction](
    endpoint: ParticipantHandle,
    address: ConversationAddress,
    messages: Stream.Stream<HarnessTurn, NetworkError>,
  ): ConversationSocket {
    return new ConversationSocket(endpoint, address, messages);
  }

  /**
   * Receive the next ordered turn. Selection policy belongs in the consuming
   * Effect, so the socket never skips an earlier turn.
   * @returns The next turn, or a typed receive failure when the stream ends.
   */
  receive(): Effect.Effect<HarnessTurn, NetworkError> {
    return this.messages.pipe(
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              networkError(
                "receive",
                `conversation ${this.address.conversationId} ended before another turn arrived`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  }
}

/**
 * Bind an endpoint receiver to an existing address.
 * @param endpoint Controlled endpoint that receives the conversation.
 * @param address Participant-independent conversation address.
 * @param messages Ordered turn stream for this endpoint and conversation.
 * @returns The address bound to the selected endpoint.
 */
export function makeConversationSocket(
  endpoint: ParticipantHandle,
  address: ConversationAddress,
  messages: Stream.Stream<HarnessTurn, NetworkError>,
): ConversationSocket {
  return Object.freeze(
    ConversationSocket[conversationSocketConstruction](
      endpoint,
      address,
      messages,
    ),
  );
}
