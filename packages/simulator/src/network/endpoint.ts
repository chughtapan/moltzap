/** @file Controlled network endpoints and their run-scoped Effect service. */

import type { InboundDelivery, SendInput } from "@moltzap/client";
import { Context, type Effect, type Stream } from "effect";
import type { NetworkError } from "./failure.js";
import type { ParticipantHandle } from "./participant.js";
import type { AttachedEndpoint, EndpointTransport } from "./router.js";

const endpointTypeId: unique symbol = Symbol("@moltzap/simulator/Endpoint");
const endpointConstruction: unique symbol = Symbol(
  "@moltzap/simulator/EndpointConstruction",
);

/** Run-scoped delivery stream maintained by the simulator kernel. */
export interface EndpointInbox {
  /** Live fan-out stream for observers of every endpoint delivery. */
  readonly messages: Stream.Stream<InboundDelivery, NetworkError>;
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
   * Send one explicit addressed post through the endpoint daemon.
   * @param input Explicit destination and nonempty content.
   * @returns Completion after the daemon certifies the addressed post.
   */
  send(input: SendInput): Effect.Effect<void, NetworkError> {
    return this.transport.send(input);
  }

  /**
   * Observe addressed deliveries emitted after this stream is subscribed.
   * @returns A live fan-out stream of deliveries for this endpoint.
   */
  messages(): Stream.Stream<InboundDelivery, NetworkError> {
    return this.inbox.messages;
  }
}

/**
 * Construct a controlled endpoint from one ready attachment and its inbox.
 * @param attachment Ready participant and semantic daemon transport.
 * @param inbox Run-owned endpoint delivery stream.
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
