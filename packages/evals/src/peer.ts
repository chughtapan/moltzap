/** @file Autonomous Effect policies for bundled mixed-agent evaluations. */

import {
  agentConversationCreate,
  type ConversationId,
} from "@moltzap/protocol/conversation";
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
const GROUP_MEMBER_RESOLUTION_CONCURRENCY = 4;
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
  readonly conversationId: ConversationId;
}

interface PreparedGroup {
  readonly target: AgentCard;
  readonly conversation: PeerConversation;
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
  return notification.message.conversationId === conversation.conversationId;
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
    conversationId: notification.message.conversationId,
    messageId: notification.message.id,
    senderId: notification.message.senderId,
    parts: notification.message.parts,
  });
}

function sentObservation(
  caseId: EvaluationCaseId,
  context: PeerContext,
  message: Message,
): CodePeerMessageSent {
  return CodePeerMessageSent.make({
    caseId,
    agentName: decodeAgentName(context.agent.name),
    agentId: context.agent.id,
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
      conversationId: conversation.conversationId,
      parts: [{ type: "text", text }],
    })
    .pipe(
      Effect.map((result) => sentObservation(caseId, context, result.message)),
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
        .callDefinition(agentConversationCreate, {
          participants: [target.id],
        })
        .pipe(Effect.mapError((cause) => failure("open-conversation", cause)));
      const conversation: PeerConversation = {
        conversationId: opened.conversation.id,
      };
      const sent = yield* send(context, caseId, conversation, text);
      const response = yield* receiveFrom(context, target.id, conversation);
      return new PeerExchange({
        observations: [sent, receivedObservation(caseId, context, response)],
      });
    }).pipe(Effect.withSpan("evals.peer.opening"));
}

function prepareGroup(
  context: EffectRuntimeContext,
  targetName: string,
  participantNames: NonEmptyReadonlyArray<string>,
  name: string,
): Effect.Effect<PreparedGroup, EvaluationPeerFailed> {
  return Effect.gen(function* () {
    const [target, participants] = yield* Effect.all([
      resolveAgent(context.client, targetName),
      Effect.forEach(
        participantNames,
        (participantName) => resolveAgent(context.client, participantName),
        { concurrency: GROUP_MEMBER_RESOLUTION_CONCURRENCY },
      ),
    ] as const);
    const invitedAgentIds = [
      target.id,
      ...participants.map((participant) => participant.id),
    ];
    const opened = yield* context.client
      .callDefinition(agentConversationCreate, {
        name,
        participants: invitedAgentIds,
      })
      .pipe(Effect.mapError((cause) => failure("open-conversation", cause)));
    return {
      target,
      conversation: {
        conversationId: opened.conversation.id,
      },
    };
  }).pipe(Effect.withSpan("evals.peer.prepare-group"));
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
  prepared: PreparedGroup,
  sourceName: string,
  text: string,
): PeerPolicy {
  return (context) =>
    Effect.gen(function* () {
      const source = yield* resolveAgent(context.client, sourceName);
      const contact = yield* receiveFrom(
        context,
        prepared.target.id,
        prepared.conversation,
      );
      const sourceAnnouncement = yield* receiveFrom(
        context,
        source.id,
        prepared.conversation,
      );
      const question = yield* send(
        context,
        caseId,
        prepared.conversation,
        text,
      );
      const response = yield* receiveFrom(
        context,
        prepared.target.id,
        prepared.conversation,
      );
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

function groupResponsePolicy(
  caseId: EvaluationCaseId,
  prepared: PreparedGroup,
  messages: NonEmptyReadonlyArray<string>,
): PeerPolicy {
  return (context) =>
    receiveFrom(context, prepared.target.id, prepared.conversation).pipe(
      Effect.flatMap((contact) =>
        reactiveExchange({
          context,
          caseId,
          target: prepared.target,
          contact,
          messages,
        }),
      ),
      Effect.withSpan("evals.peer.group-response"),
    );
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

interface PreparedGroupRuntimeOptions {
  readonly targetName: string;
  readonly participantNames: NonEmptyReadonlyArray<string>;
  readonly groupName: string;
  readonly policy: (prepared: PreparedGroup) => PeerPolicy;
}

function preparedGroupRuntime(
  options: PreparedGroupRuntimeOptions,
): EvaluationPeerRuntime {
  return effectRuntime({
    build: (context) =>
      Effect.gen(function* () {
        const prepared = yield* prepareGroup(
          context,
          options.targetName,
          options.participantNames,
          options.groupName,
        );
        const exchange = yield* Deferred.make<
          PeerExchange,
          EvaluationPeerFailed
        >();
        return {
          gateway: Object.freeze({ exchange: Deferred.await(exchange) }),
          behavior: runPeerPolicy(context, options.policy(prepared), exchange),
        };
      }).pipe(Effect.withSpan("evals.peer.build-prepared-group")),
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

interface OrderedGroupPeerOptions {
  readonly caseId: EvaluationCaseId;
  readonly targetName: string;
  readonly sourceName: string;
  readonly participantNames: NonEmptyReadonlyArray<string>;
  readonly groupName: string;
  readonly text: string;
}

/**
 * Build a question peer that provisions a named group and preserves its order.
 * @param options Named topology and ordered question policy.
 * @returns A runtime whose final observation is the target's response.
 */
export function orderedGroupPeerRuntime(
  options: OrderedGroupPeerOptions,
): EvaluationPeerRuntime {
  return preparedGroupRuntime({
    targetName: options.targetName,
    participantNames: options.participantNames,
    groupName: options.groupName,
    policy: (prepared) =>
      orderedGroupQuestionPolicy(
        options.caseId,
        prepared,
        options.sourceName,
        options.text,
      ),
  });
}

interface GroupResponsePeerOptions {
  readonly caseId: EvaluationCaseId;
  readonly targetName: string;
  readonly participantNames: NonEmptyReadonlyArray<string>;
  readonly groupName: string;
  readonly messages: NonEmptyReadonlyArray<string>;
}

/**
 * Build a peer that provisions a named group before runtime readiness.
 * @param options Named topology and ordered response policy.
 * @returns A runtime whose gateway reports the ordered group interaction.
 */
export function groupResponsePeerRuntime(
  options: GroupResponsePeerOptions,
): EvaluationPeerRuntime {
  return preparedGroupRuntime({
    targetName: options.targetName,
    participantNames: options.participantNames,
    groupName: options.groupName,
    policy: (prepared) =>
      groupResponsePolicy(options.caseId, prepared, options.messages),
  });
}
