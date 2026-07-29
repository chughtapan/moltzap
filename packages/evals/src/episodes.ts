import type { AgentId } from "@moltzap/protocol/identity";
import type { ReceivedMessage } from "@moltzap/simulator";
import {
  type AgentHandle,
  type ConversationSocket,
  Network,
  type NetworkFailure,
} from "@moltzap/simulator";
import { Effect, type Scope } from "effect";

export const TARGET_AGENT_NAME = "evaluation-target";
export const SENDER_NAME = "eval-sender";
export const PROBE_SENDER_NAME = "eval-probe-sender";
const BYSTANDER_NAME = "group-bystander-1";
const QUIET_BYSTANDER_ONE = "group-bystander-1";
const QUIET_BYSTANDER_TWO = "group-bystander-2";

/** One target delivery annotated with customer-owned endpoint semantics. */
export interface EpisodeResponse {
  readonly endpointName: string;
  readonly endpointId: AgentId;
  readonly targetName: string;
  readonly targetId: AgentId;
  readonly received: ReceivedMessage;
}

type EpisodeFailure = NetworkFailure;
type EpisodeRequirements = Network | Scope.Scope;

function responseAt(
  endpoint: {
    readonly participant: {
      readonly name: string;
      readonly id: AgentId;
    };
  },
  target: AgentHandle,
  received: ReceivedMessage,
): EpisodeResponse {
  return {
    endpointName: endpoint.participant.name,
    endpointId: endpoint.participant.id,
    targetName: target.name,
    targetId: target.id,
    received,
  };
}

/**
 * Evaluation policy deliberately consumes deliveries until one matches.
 * The simulator socket itself only exposes ordered receive semantics.
 */
function receiveWhere(
  socket: ConversationSocket,
  predicate: (received: ReceivedMessage) => boolean,
): Effect.Effect<ReceivedMessage, NetworkFailure> {
  return socket
    .receive()
    .pipe(
      Effect.flatMap((received) =>
        predicate(received)
          ? Effect.succeed(received)
          : Effect.suspend(() => receiveWhere(socket, predicate)),
      ),
    );
}

/** One direct conversation and one target response. */
export function directEpisode(
  target: AgentHandle,
  prompt: string,
): Effect.Effect<
  ReadonlyArray<EpisodeResponse>,
  EpisodeFailure,
  EpisodeRequirements
> {
  return Effect.gen(function* () {
    const network = yield* Network;
    const sender = yield* network.endpoint(SENDER_NAME);
    const conversation = yield* sender.open(target);
    yield* conversation.send(prompt);
    const received = yield* receiveWhere(
      conversation,
      (delivery) => delivery.message.senderId === target.id,
    );
    return [responseAt(sender, target, received)];
  }).pipe(Effect.withSpan("directEpisode"));
}

/** Two or more turns in one direct conversation. */
export function directMultiTurnEpisode(
  target: AgentHandle,
  opening: string,
  followUps: ReadonlyArray<string>,
): Effect.Effect<
  ReadonlyArray<EpisodeResponse>,
  EpisodeFailure,
  EpisodeRequirements
> {
  return Effect.gen(function* () {
    const network = yield* Network;
    const sender = yield* network.endpoint(SENDER_NAME);
    const conversation = yield* sender.open(target);
    yield* conversation.send(opening);
    let latest = yield* receiveWhere(
      conversation,
      (delivery) => delivery.message.senderId === target.id,
    );
    const responses = new Set([latest.message.id]);
    const selected = [responseAt(sender, target, latest)];

    for (const followUp of followUps) {
      const previousId = latest.message.id;
      yield* conversation.send(followUp);
      latest = yield* receiveWhere(
        conversation,
        (delivery) =>
          delivery.message.senderId === target.id &&
          delivery.message.id !== previousId &&
          !responses.has(delivery.message.id),
      );
      responses.add(latest.message.id);
      selected.push(responseAt(sender, target, latest));
    }
    return selected;
  }).pipe(Effect.withSpan("directMultiTurnEpisode"));
}

/**
 * An endpoint bystander speaks first, then a second endpoint addresses the
 * target in the same group conversation.
 */
export function speakingGroupEpisode(
  target: AgentHandle,
  bystanderMessage: string,
  prompt: string,
): Effect.Effect<
  ReadonlyArray<EpisodeResponse>,
  EpisodeFailure,
  EpisodeRequirements
> {
  return Effect.gen(function* () {
    const network = yield* Network;
    const sender = yield* network.endpoint(SENDER_NAME);
    const bystander = yield* network.endpoint(BYSTANDER_NAME);
    const conversation = yield* bystander.open(target, sender.participant);

    yield* conversation.send(bystanderMessage);
    const first = yield* receiveWhere(
      conversation,
      (delivery) => delivery.message.senderId === target.id,
    );

    const senderConversation = yield* sender.socket(conversation.address);
    yield* senderConversation.send(prompt);
    const second = yield* receiveWhere(
      senderConversation,
      (delivery) =>
        delivery.message.senderId === target.id &&
        delivery.message.id !== first.message.id,
    );
    return [
      responseAt(bystander, target, first),
      responseAt(sender, target, second),
    ];
  }).pipe(Effect.withSpan("speakingGroupEpisode"));
}

/** One group prompt with silent experiment-controlled endpoints. */
export function silentGroupEpisode(
  target: AgentHandle,
  prompt: string,
): Effect.Effect<
  ReadonlyArray<EpisodeResponse>,
  EpisodeFailure,
  EpisodeRequirements
> {
  return Effect.gen(function* () {
    const network = yield* Network;
    const sender = yield* network.endpoint(SENDER_NAME);
    const bystanderOne = yield* network.endpoint(QUIET_BYSTANDER_ONE);
    const bystanderTwo = yield* network.endpoint(QUIET_BYSTANDER_TWO);
    const conversation = yield* sender.open(
      target,
      bystanderOne.participant,
      bystanderTwo.participant,
    );
    yield* conversation.send(prompt);
    const received = yield* receiveWhere(
      conversation,
      (delivery) => delivery.message.senderId === target.id,
    );
    return [responseAt(sender, target, received)];
  }).pipe(Effect.withSpan("silentGroupEpisode"));
}

/**
 * Establish context with one endpoint, then probe the target from another
 * endpoint in a distinct conversation.
 */
export function crossConversationEpisode(options: {
  readonly target: AgentHandle;
  readonly setup: string;
  readonly probe: string;
  readonly followUps?: ReadonlyArray<string>;
}): Effect.Effect<
  ReadonlyArray<EpisodeResponse>,
  EpisodeFailure,
  EpisodeRequirements
> {
  return Effect.gen(function* () {
    const followUps = options.followUps ?? [];
    const network = yield* Network;
    const sender = yield* network.endpoint(SENDER_NAME);
    const setupConversation = yield* sender.open(options.target);
    yield* setupConversation.send(options.setup);
    let latestSetup = yield* receiveWhere(
      setupConversation,
      (delivery) => delivery.message.senderId === options.target.id,
    );
    const responses = new Set([latestSetup.message.id]);

    for (const followUp of followUps) {
      const previousId = latestSetup.message.id;
      yield* setupConversation.send(followUp);
      latestSetup = yield* receiveWhere(
        setupConversation,
        (delivery) =>
          delivery.message.senderId === options.target.id &&
          delivery.message.id !== previousId &&
          !responses.has(delivery.message.id),
      );
      responses.add(latestSetup.message.id);
    }

    const probeSender = yield* network.endpoint(PROBE_SENDER_NAME);
    const probeConversation = yield* probeSender.open(options.target);
    yield* probeConversation.send(options.probe);
    const probeResponse = yield* receiveWhere(
      probeConversation,
      (delivery) => delivery.message.senderId === options.target.id,
    );
    return [
      responseAt(sender, options.target, latestSetup),
      responseAt(probeSender, options.target, probeResponse),
    ];
  }).pipe(Effect.withSpan("crossConversationEpisode"));
}
