/** @file Autonomous Effect policies for bundled mixed-agent evaluations. */

import {
  agentName,
  agentsList,
  type AgentCard,
  type AgentId,
} from "@moltzap/protocol/identity";
import {
  messagesSend,
  type Message,
  type MessageReceivedNotification,
} from "@moltzap/protocol/message";
import { DEFAULT_APP_ID, taskRequest } from "@moltzap/protocol/task";
import type { ListCursor } from "@moltzap/protocol/rpc";
import {
  type AgentRuntime,
  type EffectRuntimeStartFailed,
  effectRuntime,
  type EffectRuntimeContext,
} from "@moltzap/simulator/runtime";
import { Deferred, Data, Effect, Mailbox, Schedule, Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { CodePeerMessageReceived, CodePeerMessageSent } from "./events.js";
import type { EvaluationCaseId } from "./model.js";

const AGENT_PAGE_SIZE = 100;
const AGENT_POLL_INTERVAL = "100 millis";
const decodeAgentName = Schema.decodeSync(agentName);

/** Endpoint testimony produced by one bundled code peer. */
export type EvaluationPeerObservation =
  | CodePeerMessageReceived
  | CodePeerMessageSent;
type PeerClient = EffectRuntimeContext["client"];

interface PeerContext {
  readonly agent: EffectRuntimeContext["agent"];
  readonly client: PeerClient;
  readonly inbox: Mailbox.ReadonlyMailbox<MessageReceivedNotification, unknown>;
}

/** One completed peer interaction in exact production-protocol order. */
export class PeerExchange extends Data.Class<{
  readonly observations: NonEmptyReadonlyArray<EvaluationPeerObservation>;
}> {}

/** A bundled code peer could not complete its production-protocol policy. */
export class EvaluationPeerFailed extends Schema.TaggedError<EvaluationPeerFailed>()(
  "EvaluationPeerFailed",
  {
    operation: Schema.Literal(
      "resolve-agent",
      "open-conversation",
      "receive",
      "send",
    ),
    detail: Schema.NonEmptyString,
  },
) {}

/**
 * Exact principal surface for bundled evaluation peers.
 *
 * The peer is autonomous. Its gateway reports what that policy observed; it
 * does not carry a generic command language or mirror a process transport.
 */
export interface EvaluationPeerGateway {
  readonly exchange: Effect.Effect<PeerExchange, EvaluationPeerFailed>;
}

/** Reusable in-process runtime shape shared by bundled autonomous peers. */
export type EvaluationPeerRuntime = AgentRuntime<
  EvaluationPeerGateway,
  EffectRuntimeStartFailed
>;

interface PeerConversation {
  readonly taskId: MessageReceivedNotification["taskId"];
  readonly conversationId: Message["conversationId"];
}

type PeerPolicy = (
  context: PeerContext,
) => Effect.Effect<PeerExchange, EvaluationPeerFailed>;

function failure(
  operation: EvaluationPeerFailed["operation"],
  cause: unknown,
): EvaluationPeerFailed {
  const rendered = String(cause).trim();
  return EvaluationPeerFailed.make({
    operation,
    detail:
      rendered.length === 0
        ? "operation failed without a diagnostic"
        : rendered,
  });
}

function findAgent(
  client: PeerClient,
  name: string,
): Effect.Effect<AgentCard, EvaluationPeerFailed> {
  return Effect.gen(function* () {
    let cursor: ListCursor | undefined;
    do {
      const page = yield* client
        .callDefinition(agentsList, {
          limit: AGENT_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        })
        .pipe(Effect.mapError((cause) => failure("resolve-agent", cause)));
      const matched = page.agents.find((agent) => agent.name === name);
      if (matched !== undefined) {
        return matched;
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return yield* Effect.fail(
      failure("resolve-agent", `agent ${JSON.stringify(name)} is not ready`),
    );
  });
}

function resolveAgent(
  client: PeerClient,
  name: string,
): Effect.Effect<AgentCard, EvaluationPeerFailed> {
  return findAgent(client, name).pipe(
    Effect.retry(Schedule.spaced(AGENT_POLL_INTERVAL)),
  );
}

function sameConversation(
  notification: MessageReceivedNotification,
  conversation: PeerConversation,
): boolean {
  return (
    notification.taskId === conversation.taskId &&
    notification.message.conversationId === conversation.conversationId
  );
}

function receiveFrom(
  context: PeerContext,
  senderId: AgentId,
  conversation?: PeerConversation,
): Effect.Effect<MessageReceivedNotification, EvaluationPeerFailed> {
  return Effect.gen(function* () {
    while (true) {
      const notification = yield* context.inbox.take.pipe(
        Effect.mapError((cause) => failure("receive", cause)),
      );
      if (
        notification.message.senderId === senderId &&
        (conversation === undefined ||
          sameConversation(notification, conversation))
      ) {
        return notification;
      }
    }
  });
}

function receivedObservation(
  caseId: EvaluationCaseId,
  context: PeerContext,
  notification: MessageReceivedNotification,
): CodePeerMessageReceived {
  return CodePeerMessageReceived.make({
    caseId,
    agentName: decodeAgentName(context.agent.name),
    agentId: context.agent.id,
    taskId: notification.taskId,
    conversationId: notification.message.conversationId,
    messageId: notification.message.id,
    senderId: notification.message.senderId,
    parts: notification.message.parts,
  });
}

function sentObservation(
  caseId: EvaluationCaseId,
  context: PeerContext,
  taskId: MessageReceivedNotification["taskId"],
  message: Message,
): CodePeerMessageSent {
  return CodePeerMessageSent.make({
    caseId,
    agentName: decodeAgentName(context.agent.name),
    agentId: context.agent.id,
    taskId,
    conversationId: message.conversationId,
    messageId: message.id,
    parts: message.parts,
  });
}

function send(
  context: PeerContext,
  caseId: EvaluationCaseId,
  conversation: PeerConversation,
  text: string,
): Effect.Effect<CodePeerMessageSent, EvaluationPeerFailed> {
  return context.client
    .callDefinition(messagesSend, {
      taskId: conversation.taskId,
      conversationId: conversation.conversationId,
      parts: [{ type: "text", text }],
    })
    .pipe(
      Effect.map((result) =>
        sentObservation(caseId, context, conversation.taskId, result.message),
      ),
      Effect.mapError((cause) => failure("send", cause)),
    );
}

interface ReactiveExchangeInput {
  readonly context: PeerContext;
  readonly caseId: EvaluationCaseId;
  readonly target: AgentCard;
  readonly contact: MessageReceivedNotification;
  readonly messages: NonEmptyReadonlyArray<string>;
}

function reactiveExchange({
  context,
  caseId,
  target,
  contact,
  messages,
}: ReactiveExchangeInput): Effect.Effect<PeerExchange, EvaluationPeerFailed> {
  return Effect.gen(function* () {
    const conversation: PeerConversation = {
      taskId: contact.taskId,
      conversationId: contact.message.conversationId,
    };
    const [firstMessage, ...remainingMessages] = messages;
    const observations: [
      EvaluationPeerObservation,
      ...EvaluationPeerObservation[],
    ] = [receivedObservation(caseId, context, contact)];
    observations.push(yield* send(context, caseId, conversation, firstMessage));
    let selected = receivedObservation(
      caseId,
      context,
      yield* receiveFrom(context, target.id, conversation),
    );
    for (const text of remainingMessages) {
      observations.push(selected);
      observations.push(yield* send(context, caseId, conversation, text));
      selected = receivedObservation(
        caseId,
        context,
        yield* receiveFrom(context, target.id, conversation),
      );
    }
    return new PeerExchange({
      observations: [...observations, selected],
    });
  });
}

function reactivePolicy(
  caseId: EvaluationCaseId,
  targetName: string,
  messages: NonEmptyReadonlyArray<string>,
): PeerPolicy {
  return (context) =>
    Effect.gen(function* () {
      const target = yield* resolveAgent(context.client, targetName);
      const contact = yield* receiveFrom(context, target.id);
      return yield* reactiveExchange({
        context,
        caseId,
        target,
        contact,
        messages,
      });
    }).pipe(Effect.withSpan("evals.peer.reactive"));
}

function openingPolicy(
  caseId: EvaluationCaseId,
  targetName: string,
  text: string,
): PeerPolicy {
  return (context) =>
    Effect.gen(function* () {
      const target = yield* resolveAgent(context.client, targetName);
      const opened = yield* context.client
        .callDefinition(taskRequest, {
          appId: DEFAULT_APP_ID,
          invitedAgentIds: [target.id],
          initialConversation: { participants: [target.id] },
        })
        .pipe(Effect.mapError((cause) => failure("open-conversation", cause)));
      if (opened.conversation === null) {
        return yield* Effect.fail(
          failure(
            "open-conversation",
            "the router returned no initial conversation",
          ),
        );
      }
      const conversation: PeerConversation = {
        taskId: opened.task.id,
        conversationId: opened.conversation.id,
      };
      const sent = yield* send(context, caseId, conversation, text);
      const response = yield* receiveFrom(context, target.id, conversation);
      return new PeerExchange({
        observations: [sent, receivedObservation(caseId, context, response)],
      });
    }).pipe(Effect.withSpan("evals.peer.opening"));
}

function sourceAnnouncementPolicy(
  caseId: EvaluationCaseId,
  targetName: string,
  text: string,
): PeerPolicy {
  return (context) =>
    Effect.gen(function* () {
      const target = yield* resolveAgent(context.client, targetName);
      const contact = yield* receiveFrom(context, target.id);
      const conversation: PeerConversation = {
        taskId: contact.taskId,
        conversationId: contact.message.conversationId,
      };
      const announcement = yield* send(context, caseId, conversation, text);
      return new PeerExchange({
        observations: [
          receivedObservation(caseId, context, contact),
          announcement,
        ],
      });
    }).pipe(Effect.withSpan("evals.peer.source-announcement"));
}

function observerPolicy(
  caseId: EvaluationCaseId,
  targetName: string,
): PeerPolicy {
  return (context) =>
    Effect.gen(function* () {
      const target = yield* resolveAgent(context.client, targetName);
      const contact = yield* receiveFrom(context, target.id);
      return new PeerExchange({
        observations: [receivedObservation(caseId, context, contact)],
      });
    }).pipe(Effect.withSpan("evals.peer.observer"));
}

function orderedGroupQuestionPolicy(
  caseId: EvaluationCaseId,
  targetName: string,
  sourceName: string,
  text: string,
): PeerPolicy {
  return (context) =>
    Effect.gen(function* () {
      const [target, source] = yield* Effect.all([
        resolveAgent(context.client, targetName),
        resolveAgent(context.client, sourceName),
      ]);
      const contact = yield* receiveFrom(context, target.id);
      const conversation: PeerConversation = {
        taskId: contact.taskId,
        conversationId: contact.message.conversationId,
      };
      const sourceAnnouncement = yield* receiveFrom(
        context,
        source.id,
        conversation,
      );
      const question = yield* send(context, caseId, conversation, text);
      const response = yield* receiveFrom(context, target.id, conversation);
      return new PeerExchange({
        observations: [
          receivedObservation(caseId, context, contact),
          receivedObservation(caseId, context, sourceAnnouncement),
          question,
          receivedObservation(caseId, context, response),
        ],
      });
    }).pipe(Effect.withSpan("evals.peer.ordered-group-question"));
}

function runPeerPolicy(
  context: EffectRuntimeContext,
  policy: PeerPolicy,
  exchange: Deferred.Deferred<PeerExchange, EvaluationPeerFailed>,
) {
  const completed = Effect.gen(function* () {
    const inbox = yield* Mailbox.fromStream(context.messages);
    return yield* policy(
      Object.freeze({
        agent: context.agent,
        client: context.client,
        inbox,
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.onExit((exit) => Deferred.done(exchange, exit).pipe(Effect.asVoid)),
  );
  return completed.pipe(Effect.andThen(Effect.never));
}

function peerRuntime(policy: PeerPolicy): EvaluationPeerRuntime {
  return effectRuntime({
    build: (context) =>
      Effect.gen(function* () {
        const exchange = yield* Deferred.make<
          PeerExchange,
          EvaluationPeerFailed
        >();
        return {
          gateway: Object.freeze({
            exchange: Deferred.await(exchange),
          }),
          behavior: runPeerPolicy(context, policy, exchange),
        };
      }).pipe(Effect.withSpan("evals.peer.build")),
  });
}

/**
 * Build an autonomous peer that responds to a target-created conversation.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name the peer accepts messages from.
 * @param messages Ordered peer messages, each followed by one target response.
 * @returns A runtime whose gateway reports the ordered interaction.
 */
export function selectedResponsePeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
  messages: NonEmptyReadonlyArray<string>,
) {
  return peerRuntime(reactivePolicy(caseId, targetName, messages));
}

/**
 * Build an autonomous context peer whose response is not selected for grading.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name the peer accepts messages from.
 * @param messages Ordered peer messages, each followed by one target response.
 * @returns A runtime whose gateway reports the complete interaction.
 */
export function contextPeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
  messages: NonEmptyReadonlyArray<string>,
) {
  return peerRuntime(reactivePolicy(caseId, targetName, messages));
}

/**
 * Build the identity-awareness peer that creates the social workspace.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name the peer contacts.
 * @param text Initial peer message.
 * @returns A runtime whose gateway reports the complete interaction.
 */
export function openingPeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
  text: string,
) {
  return peerRuntime(openingPolicy(caseId, targetName, text));
}

/**
 * Build a source peer that contributes to a target-created group.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name whose first message identifies the group.
 * @param text Source announcement sent into that exact conversation.
 * @returns A runtime whose gateway reports the contact and announcement.
 */
export function announcementPeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
  text: string,
) {
  return peerRuntime(sourceAnnouncementPolicy(caseId, targetName, text));
}

/**
 * Build an observer that records the target's first delivered message.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name whose first delivery is observed.
 * @returns A runtime whose gateway reports one production-stream delivery.
 */
export function observerPeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
) {
  return peerRuntime(observerPolicy(caseId, targetName));
}

/**
 * Build a question peer that preserves the group interaction order.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name whose first message identifies the group.
 * @param sourceName Roster name that must announce before the question.
 * @param text Question sent after both preceding group messages arrive.
 * @returns A runtime whose final observation is the target's response.
 */
export function orderedGroupPeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
  sourceName: string,
  text: string,
) {
  return peerRuntime(
    orderedGroupQuestionPolicy(caseId, targetName, sourceName, text),
  );
}
