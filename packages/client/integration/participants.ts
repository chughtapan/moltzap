/** @file Endpoints a collective-operation trace drives through real daemons. */

import type { AgentName } from "@moltzap/identity";
import { Effect, Queue, Schema, type Scope, Stream } from "effect";
import {
  acquireHarnessEndpoint,
  AgentAddress,
  type HarnessEndpoint,
  type InboundDelivery,
  type InboundItem,
  SendInput,
} from "../src/index.js";
import {
  type DaemonProcessFixture,
  ProcessTestError,
} from "./daemon-process-harness.js";

/** One endpoint and the items its subscription has delivered, in order. */
export interface Participant {
  readonly address: AgentAddress;
  readonly endpoint: HarnessEndpoint;
  readonly inbox: Queue.Queue<InboundDelivery>;
}

function directAddress(agentName: AgentName): AgentAddress {
  return Schema.decodeUnknownSync(AgentAddress)(`agent:${agentName}`);
}

/**
 * Acquires the endpoint of `fixture`'s running daemon and queues every
 * delivery its subscription receives.
 */
export const joinParticipant = (
  fixture: DaemonProcessFixture,
): Effect.Effect<Participant, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const endpoint = yield* acquireHarnessEndpoint(fixture.endpoint).pipe(
      Effect.mapError(
        (cause) =>
          new ProcessTestError({
            message: "endpoint acquisition failed",
            cause,
          }),
      ),
    );
    const inbox = yield* Queue.unbounded<InboundDelivery>();
    yield* endpoint.messages.pipe(
      Stream.runForEach((delivery) => Queue.offer(inbox, delivery)),
      Effect.forkScoped,
    );
    return { address: directAddress(fixture.agentName), endpoint, inbox };
  });

/** Take the participant's next item and acknowledge its delivery. */
export const nextItem = (participant: Participant) =>
  Queue.take(participant.inbox).pipe(
    Effect.tap((delivery) => delivery.acknowledge),
    Effect.map((delivery): InboundItem => delivery.item),
  );

/** Sends `input`, decoded as a host's send input, from `participant`. */
export const send = (participant: Participant, input: unknown) =>
  participant.endpoint.send(Schema.decodeUnknownSync(SendInput)(input));

/** The fixed-member group address of `participants`. */
export const groupAddress = (participants: readonly Participant[]): string =>
  `group:${participants
    .map(({ address }) => address.slice("agent:".length))
    .join(",")}`;

/**
 * A post from `requester` to its group with `members`, received by each
 * member: the round `measuredDeadlineSeconds` times.
 */
export const groupRound = (
  requester: Participant,
  members: readonly Participant[],
) =>
  send(requester, {
    to: groupAddress([requester, ...members]),
    text: "one measured round",
  }).pipe(Effect.zipRight(Effect.forEach(members, nextItem)));
