/** @file Participant-independent conversation addressing. */

import type { ConversationId } from "@moltzap/client";
import { type Message, messagePartsSchema } from "@moltzap/protocol/message";
import { Effect, Option, Schema, Stream } from "effect";
import type { ParticipantHandle } from "./participant.js";
import type { MessageParts, ReceivedMessage } from "./router.js";
import { type NetworkError, networkError } from "./failure.js";

const conversationAddressTypeId: unique symbol = Symbol(
  "@moltzap/simulator/ConversationAddress",
);
const conversationAddressConstruction: unique symbol = Symbol(
  "@moltzap/simulator/ConversationAddressConstruction",
);
const conversationSocketTypeId: unique symbol = Symbol(
  "@moltzap/simulator/ConversationSocket",
);
const conversationSocketConstruction: unique symbol = Symbol(
  "@moltzap/simulator/ConversationSocketConstruction",
);
const messagePartsSchemaValue = messagePartsSchema();

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

  private constructor(
    conversationId: ConversationId,
    participants: ConversationParticipants,
  ) {
    this.conversationId = conversationId;
    this.participants = participants;
  }

  static [conversationAddressConstruction](
    conversationId: ConversationId,
    participants: ConversationParticipants,
  ): ConversationAddress {
    return new ConversationAddress(conversationId, participants);
  }
}

/**
 * Construct an address from one router-issued conversation identity.
 * @param conversationId Stable conversation identity.
 * @param participants Nonempty addressed participant set.
 * @returns Nominal conversation address.
 * @internal
 */
export function makeConversationAddress(
  conversationId: ConversationId,
  participants: ConversationParticipants,
): ConversationAddress {
  const [first, ...rest] = participants;
  return Object.freeze(
    ConversationAddress[conversationAddressConstruction](
      conversationId,
      Object.freeze([first, ...rest]),
    ),
  );
}

function parts(content: string | MessageParts): MessageParts {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

function validateParts(
  content: MessageParts,
): Effect.Effect<MessageParts, NetworkError> {
  return Schema.decodeUnknown(messagePartsSchemaValue)(content, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => networkError("send", cause)),
    Effect.as(content),
  );
}

/** A conversation address bound to exactly one controlled endpoint. */
// eslint-disable-next-line agent-code-guard/max-non-trivial-classes-per-file -- an address and its endpoint-bound socket are the two faces of one conversation capability
export class ConversationSocket {
  readonly [conversationSocketTypeId] = conversationSocketTypeId;

  /**
   * The ordered receive cursor for this endpoint and conversation. Repeated
   * consumption advances the cursor instead of replaying old delivery.
   */
  readonly messages: Stream.Stream<ReceivedMessage, NetworkError>;

  readonly endpoint: ParticipantHandle;
  readonly address: ConversationAddress;
  private readonly sendMessage: (
    content: MessageParts,
  ) => Effect.Effect<Message, NetworkError>;

  private constructor(
    endpoint: ParticipantHandle,
    address: ConversationAddress,
    messages: Stream.Stream<ReceivedMessage, NetworkError>,
    sendMessage: (
      content: MessageParts,
    ) => Effect.Effect<Message, NetworkError>,
  ) {
    this.endpoint = endpoint;
    this.address = address;
    this.sendMessage = sendMessage;
    this.messages = messages;
  }

  static [conversationSocketConstruction](
    endpoint: ParticipantHandle,
    address: ConversationAddress,
    messages: Stream.Stream<ReceivedMessage, NetworkError>,
    sendMessage: (
      content: MessageParts,
    ) => Effect.Effect<Message, NetworkError>,
  ): ConversationSocket {
    return new ConversationSocket(endpoint, address, messages, sendMessage);
  }

  /**
   * Commit one message through the bound endpoint.
   * @param content Value supplied to the operation.
   * @returns The created conversation socket.
   */
  send(content: string | MessageParts): Effect.Effect<Message, NetworkError> {
    return validateParts(parts(content)).pipe(Effect.flatMap(this.sendMessage));
  }

  /**
   * Receive the next ordered delivery. Selection policy belongs in the
   * consuming Effect, so the socket never skips an earlier message.
   * @returns The created conversation socket.
   */
  receive(): Effect.Effect<ReceivedMessage, NetworkError> {
    return this.messages.pipe(
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              networkError(
                "receive",
                `conversation ${this.address.conversationId} ended before another message arrived`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  }
}

/**
 * Bind an endpoint receiver and sender to an existing address.
 * @param endpoint Value supplied to the operation.
 * @param address Value supplied to the operation.
 * @param messages Value supplied to the operation.
 * @param sendMessage Value supplied to the operation.
 * @returns The created conversation socket.
 */
export function makeConversationSocket(
  endpoint: ParticipantHandle,
  address: ConversationAddress,
  messages: Stream.Stream<ReceivedMessage, NetworkError>,
  sendMessage: (content: MessageParts) => Effect.Effect<Message, NetworkError>,
): ConversationSocket {
  const socket = ConversationSocket[conversationSocketConstruction](
    endpoint,
    address,
    messages,
    sendMessage,
  );
  Object.freeze(socket);
  return socket;
}
