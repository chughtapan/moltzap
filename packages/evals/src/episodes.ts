import type { MessageId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  type ReceivedMessage,
  type AgentHandle,
  type ConversationSocket,
  Network,
  type NetworkFailure,
} from "@moltzap/simulator";
import { networkFailure } from "@moltzap/simulator/network";
import { Effect, Schema, type Scope } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

/** Provides the target agent name runtime value. */
export const TARGET_AGENT_NAME = "evaluation-target";
/** Provides the sender name runtime value. */
export const SENDER_NAME = "eval-sender";
/** Provides the probe sender name runtime value. */
export const PROBE_SENDER_NAME = "eval-probe-sender";
const BYSTANDER_NAME = "group-bystander-1";
const QUIET_BYSTANDER_ONE = "group-bystander-1";
const QUIET_BYSTANDER_TWO = "group-bystander-2";

/** Evaluation-owned meaning assigned to one simulator participant. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- evaluation events and transcripts share this closed role vocabulary.
export const EpisodeParticipantRole = Schema.Literal(
  "target",
  "sender",
  "probe",
  "bystander",
);
export type EpisodeParticipantRole = typeof EpisodeParticipantRole.Type;

/** One participant whose role is known by the episode, not the network. */
export interface EpisodeParticipant {
  readonly name: string;
  readonly id: AgentId;
  readonly role: EpisodeParticipantRole;
}

/** One target delivery annotated with customer-owned endpoint semantics. */
export interface EpisodeResponse {
  readonly endpointName: string;
  readonly endpointId: AgentId;
  readonly targetName: string;
  readonly targetId: AgentId;
  readonly promptMessageId: MessageId;
  readonly received: ReceivedMessage;
}

/** One episode-owned topology and its canonical rubric evidence. */
export interface EpisodeResult {
  readonly participants: NonEmptyReadonlyArray<EpisodeParticipant>;
  readonly selectedResponses: NonEmptyReadonlyArray<EpisodeResponse>;
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
  promptMessageId: MessageId,
  received: ReceivedMessage,
): EpisodeResponse {
  return {
    endpointName: endpoint.participant.name,
    endpointId: endpoint.participant.id,
    targetName: target.name,
    targetId: target.id,
    promptMessageId,
    received,
  };
}

function episodeResult(
  participants: NonEmptyReadonlyArray<EpisodeParticipant>,
  selectedResponses: NonEmptyReadonlyArray<EpisodeResponse>,
): EpisodeResult {
  return { participants, selectedResponses };
}

function participant(
  value: {
    readonly name: string;
    readonly id: AgentId;
  },
  role: EpisodeParticipantRole,
): EpisodeParticipant {
  return { name: value.name, id: value.id, role };
}

/**
 * Evaluation policy deliberately consumes deliveries until one matches.
 * The simulator socket itself only exposes ordered receive semantics.
 * @param socket Value supplied to the operation.
 * @param predicate Predicate used to select matching values.
 * @returns The receive where result.
 */
function receiveTargetReply(
  socket: ConversationSocket,
  targetId: AgentId,
  promptMessageId: MessageId,
  priorPromptIds: ReadonlySet<MessageId> = new Set(),
): Effect.Effect<ReceivedMessage, NetworkFailure> {
  return socket.receive().pipe(
    Effect.flatMap((received) => {
      if (received.message.senderId !== targetId) {
        return Effect.suspend(() =>
          receiveTargetReply(socket, targetId, promptMessageId, priorPromptIds),
        );
      }
      if (received.message.replyToId === promptMessageId) {
        return Effect.succeed(received);
      }
      if (
        received.message.replyToId !== undefined &&
        priorPromptIds.has(received.message.replyToId)
      ) {
        return Effect.suspend(() =>
          receiveTargetReply(socket, targetId, promptMessageId, priorPromptIds),
        );
      }
      const correlation =
        received.message.replyToId === undefined
          ? "no replyToId"
          : `foreign replyToId ${received.message.replyToId}`;
      return Effect.fail(
        networkFailure(
          "receive",
          `target response ${received.message.id} has ${correlation}; expected a reply to prompt ${promptMessageId}`,
        ),
      );
    }),
  );
}

function receiveGradedGroupResponse(
  socket: ConversationSocket,
  targetId: AgentId,
  setupMessageId: MessageId,
  gradedPromptId: MessageId,
): Effect.Effect<ReceivedMessage, NetworkFailure> {
  return socket.receive().pipe(
    Effect.flatMap((received) => {
      if (received.message.senderId !== targetId) {
        return Effect.suspend(() =>
          receiveGradedGroupResponse(
            socket,
            targetId,
            setupMessageId,
            gradedPromptId,
          ),
        );
      }
      if (received.message.replyToId === gradedPromptId) {
        return Effect.succeed(received);
      }
      if (received.message.replyToId === setupMessageId) {
        return Effect.suspend(() =>
          receiveGradedGroupResponse(
            socket,
            targetId,
            setupMessageId,
            gradedPromptId,
          ),
        );
      }
      const correlation =
        received.message.replyToId === undefined
          ? "no replyToId"
          : `foreign replyToId ${received.message.replyToId}`;
      return Effect.fail(
        networkFailure(
          "receive",
          `target response ${received.message.id} has ${correlation}; expected a reply to graded prompt ${gradedPromptId} or setup message ${setupMessageId}`,
        ),
      );
    }),
  );
}

function establishContext(
  socket: ConversationSocket,
  targetId: AgentId,
  setup: string,
  followUps: ReadonlyArray<string>,
): Effect.Effect<void, NetworkFailure> {
  return Effect.gen(function* () {
    let prompt = yield* socket.send(setup);
    yield* receiveTargetReply(socket, targetId, prompt.id);
    const promptIds = new Set<MessageId>([prompt.id]);
    for (const followUp of followUps) {
      const priorPromptIds = new Set(promptIds);
      prompt = yield* socket.send(followUp);
      yield* receiveTargetReply(socket, targetId, prompt.id, priorPromptIds);
      promptIds.add(prompt.id);
    }
  });
}

/**
 * One direct conversation and one target response.
 * @param target Value supplied to the operation.
 * @param prompt Value supplied to the operation.
 * @returns The direct episode result.
 */
export function directEpisode(
  target: AgentHandle,
  prompt: string,
): Effect.Effect<EpisodeResult, EpisodeFailure, EpisodeRequirements> {
  return Effect.gen(function* () {
    const network = yield* Network;
    const sender = yield* network.endpoint(SENDER_NAME);
    const conversation = yield* sender.open(target);
    const sent = yield* conversation.send(prompt);
    const received = yield* receiveTargetReply(
      conversation,
      target.id,
      sent.id,
    );
    const participants = [
      participant(sender.participant, "sender"),
      participant(target, "target"),
    ] satisfies NonEmptyReadonlyArray<EpisodeParticipant>;
    return episodeResult(participants, [
      responseAt(sender, target, sent.id, received),
    ]);
  }).pipe(Effect.withSpan("directEpisode"));
}

/**
 * Two or more turns in one direct conversation.
 * @param target Value supplied to the operation.
 * @param opening Value supplied to the operation.
 * @param followUps Value supplied to the operation.
 * @returns The direct multi turn episode result.
 */
export function directMultiTurnEpisode(
  target: AgentHandle,
  opening: string,
  followUps: readonly string[],
): Effect.Effect<EpisodeResult, EpisodeFailure, EpisodeRequirements> {
  return Effect.gen(function* () {
    const network = yield* Network;
    const sender = yield* network.endpoint(SENDER_NAME);
    const conversation = yield* sender.open(target);
    const participants = [
      participant(sender.participant, "sender"),
      participant(target, "target"),
    ] satisfies NonEmptyReadonlyArray<EpisodeParticipant>;
    let prompt = yield* conversation.send(opening);
    let latest = yield* receiveTargetReply(conversation, target.id, prompt.id);
    const promptIds = new Set<MessageId>([prompt.id]);
    const selected: [EpisodeResponse, ...Array<EpisodeResponse>] = [
      responseAt(sender, target, prompt.id, latest),
    ];

    for (const followUp of followUps) {
      const priorPromptIds = new Set(promptIds);
      prompt = yield* conversation.send(followUp);
      latest = yield* receiveTargetReply(
        conversation,
        target.id,
        prompt.id,
        priorPromptIds,
      );
      promptIds.add(prompt.id);
      selected.push(responseAt(sender, target, prompt.id, latest));
    }
    return episodeResult(participants, selected);
  }).pipe(Effect.withSpan("directMultiTurnEpisode"));
}

/**
 * A bystander's committed message precedes the graded sender prompt in one
 * group conversation. The setup turn never requires a target response, and
 * only a target reply bound to the graded prompt is selected.
 * @param target Value supplied to the operation.
 * @param bystanderMessage Value supplied to the operation.
 * @param prompt Value supplied to the operation.
 * @returns The speaking group episode result.
 */
export function speakingGroupEpisode(
  target: AgentHandle,
  bystanderMessage: string,
  prompt: string,
): Effect.Effect<EpisodeResult, EpisodeFailure, EpisodeRequirements> {
  return Effect.gen(function* () {
    const network = yield* Network;
    const sender = yield* network.endpoint(SENDER_NAME);
    const bystander = yield* network.endpoint(BYSTANDER_NAME);
    const conversation = yield* bystander.open(target, sender.participant);
    const participants = [
      participant(bystander.participant, "bystander"),
      participant(sender.participant, "sender"),
      participant(target, "target"),
    ] satisfies NonEmptyReadonlyArray<EpisodeParticipant>;

    const setupMessage = yield* conversation.send(bystanderMessage);
    const senderConversation = yield* sender.socket(conversation.address);
    const gradedPrompt = yield* senderConversation.send(prompt);
    const received = yield* receiveGradedGroupResponse(
      senderConversation,
      target.id,
      setupMessage.id,
      gradedPrompt.id,
    );
    return episodeResult(participants, [
      responseAt(sender, target, gradedPrompt.id, received),
    ]);
  }).pipe(Effect.withSpan("speakingGroupEpisode"));
}

/**
 * One group prompt with silent experiment-controlled endpoints.
 * @param target Value supplied to the operation.
 * @param prompt Value supplied to the operation.
 * @returns The silent group episode result.
 */
export function silentGroupEpisode(
  target: AgentHandle,
  prompt: string,
): Effect.Effect<EpisodeResult, EpisodeFailure, EpisodeRequirements> {
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
    const participants = [
      participant(sender.participant, "sender"),
      participant(bystanderOne.participant, "bystander"),
      participant(bystanderTwo.participant, "bystander"),
      participant(target, "target"),
    ] satisfies NonEmptyReadonlyArray<EpisodeParticipant>;
    const sent = yield* conversation.send(prompt);
    const received = yield* receiveTargetReply(
      conversation,
      target.id,
      sent.id,
    );
    return episodeResult(participants, [
      responseAt(sender, target, sent.id, received),
    ]);
  }).pipe(Effect.withSpan("silentGroupEpisode"));
}

/**
 * Establish context with one endpoint, then probe the target from another
 * endpoint in a distinct conversation.
 * @param options Options that control the operation.
 * @param options.target Value supplied to the operation.
 * @param options.setup Value supplied to the operation.
 * @param options.probe Value supplied to the operation.
 * @param options.followUps Value supplied to the operation.
 * @returns The cross conversation episode result.
 */
export function crossConversationEpisode(options: {
  readonly target: AgentHandle;
  readonly setup: string;
  readonly probe: string;
  readonly followUps?: readonly string[];
}): Effect.Effect<EpisodeResult, EpisodeFailure, EpisodeRequirements> {
  return Effect.gen(function* () {
    const followUps = options.followUps ?? [];
    const network = yield* Network;
    const sender = yield* network.endpoint(SENDER_NAME);
    const setupConversation = yield* sender.open(options.target);
    const probeSender = yield* network.endpoint(PROBE_SENDER_NAME);
    const participants = [
      participant(sender.participant, "sender"),
      participant(probeSender.participant, "probe"),
      participant(options.target, "target"),
    ] satisfies NonEmptyReadonlyArray<EpisodeParticipant>;
    yield* establishContext(
      setupConversation,
      options.target.id,
      options.setup,
      followUps,
    );

    const probeConversation = yield* probeSender.open(options.target);
    const probePrompt = yield* probeConversation.send(options.probe);
    const probeResponse = yield* receiveTargetReply(
      probeConversation,
      options.target.id,
      probePrompt.id,
    );
    return episodeResult(participants, [
      responseAt(probeSender, options.target, probePrompt.id, probeResponse),
    ]);
  }).pipe(Effect.withSpan("crossConversationEpisode"));
}
