/** @file Autonomous Effect policies for bundled mixed-agent evaluations. */

import {
  agentConversationCreate,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import {
  agentId,
  agentKey,
  agentName,
  agentsList,
  DEFAULT_APP_ID,
  type AgentCard,
  type AgentId,
} from "@moltzap/protocol/identity";
import {
  messagesSend,
  type Message,
  type MessageReceivedNotification,
} from "@moltzap/protocol/message";
import { httpBaseUrl } from "@moltzap/protocol/network";
import type { ListCursor } from "@moltzap/protocol/rpc";
import { HttpClient } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import type { MoltZapAgentClient } from "@moltzap/protocol/socket";
import {
  type AgentRuntime,
  type AgentRuntimeInput,
  defineDistributedRuntime,
  type DistributedApplicationAttachment,
  type DistributedApplicationContainer,
  type DistributedApplicationSupport,
  type DistributedBootstrapSecret,
  type DistributedContainerImage,
  RuntimeAcquisitionFailed,
} from "@moltzap/simulator/runtime";
import {
  Cause,
  Duration,
  Effect,
  Mailbox,
  Option,
  Schedule,
  Schema,
  type Stream,
} from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { CodePeerMessageReceived, CodePeerMessageSent } from "./events.js";
import { evaluationCaseId, type EvaluationCaseId } from "./model.js";

const AGENT_PAGE_SIZE = 100;
const AGENT_POLL_INTERVAL = "100 millis";
const GROUP_MEMBER_RESOLUTION_CONCURRENCY = 4;
const EVALUATION_PEER_RUNTIME_NAME = "evaluation-peer";
const EVALUATION_PEER_BRIDGE_POLL_INTERVAL = Duration.millis(100);
const EVALUATION_PEER_APPLICATION_ENTRYPOINT =
  "/opt/moltzap/node_modules/@moltzap/evals/dist/peer-application.js";
/** Mounted application configuration read only inside one peer container. */
const EVALUATION_PEER_BOOTSTRAP_PATH =
  "/var/run/moltzap/bootstrap/evaluation-peer.json";
/** Fixed controller bridge port exposed by every evaluation peer. */
export const EVALUATION_PEER_BRIDGE_PORT = 4319;
/** Application output observed by the platform before bridge attachment. */
export const EVALUATION_PEER_READY_MARKER =
  "MoltZap evaluation peer bridge ready";
const EVALUATION_PEER_RESOURCES = Object.freeze({
  cpuMillis: 100,
  memoryBytes: 128 * 1024 * 1024,
  ephemeralStorageBytes: 128 * 1024 * 1024,
});
const decodeAgentName = Schema.decodeSync(agentName);
const distributedContainerImage = Schema.String.pipe(
  Schema.pattern(/^.+@sha256:[0-9a-f]{64}$/u),
);

const evaluationPeerObservation = Schema.Union(
  CodePeerMessageReceived,
  CodePeerMessageSent,
);

/** Endpoint testimony produced by one bundled code peer. */
export type EvaluationPeerObservation = typeof evaluationPeerObservation.Type;
type PeerClient = Pick<MoltZapAgentClient, "callDefinition">;

/** Runtime context owned by the peer application process. */
export interface EvaluationPeerApplicationContext {
  readonly agent: Readonly<{
    readonly name: string;
    readonly id: AgentId;
  }>;
  readonly messages: Stream.Stream<MessageReceivedNotification, unknown>;
  readonly client: PeerClient;
}

interface PeerContext {
  readonly agent: EvaluationPeerApplicationContext["agent"];
  readonly client: PeerClient;
  readonly inbox: Mailbox.ReadonlyMailbox<MessageReceivedNotification, unknown>;
}

/** Respond in an existing target-created conversation. */
class ReactivePeerPlan extends Schema.TaggedClass<ReactivePeerPlan>()(
  "moltzap.eval-peer-reactive/v1",
  {
    caseId: evaluationCaseId,
    targetName: agentName,
    messages: Schema.NonEmptyArray(Schema.NonEmptyString),
  },
) {}

/** Open a direct conversation and send the first message. */
class OpeningPeerPlan extends Schema.TaggedClass<OpeningPeerPlan>()(
  "moltzap.eval-peer-opening/v1",
  {
    caseId: evaluationCaseId,
    targetName: agentName,
    text: Schema.NonEmptyString,
  },
) {}

/** Announce into the conversation identified by the target. */
class AnnouncementPeerPlan extends Schema.TaggedClass<AnnouncementPeerPlan>()(
  "moltzap.eval-peer-announcement/v1",
  {
    caseId: evaluationCaseId,
    targetName: agentName,
    text: Schema.NonEmptyString,
  },
) {}

/** Observe the first delivery from the target without sending. */
class ObserverPeerPlan extends Schema.TaggedClass<ObserverPeerPlan>()(
  "moltzap.eval-peer-observer/v1",
  {
    caseId: evaluationCaseId,
    targetName: agentName,
  },
) {}

/** Prepare a group and preserve contact, announcement, question, response order. */
class OrderedGroupPeerPlan extends Schema.TaggedClass<OrderedGroupPeerPlan>()(
  "moltzap.eval-peer-ordered-group/v1",
  {
    caseId: evaluationCaseId,
    targetName: agentName,
    sourceName: agentName,
    participantNames: Schema.NonEmptyArray(agentName),
    groupName: Schema.NonEmptyString,
    text: Schema.NonEmptyString,
  },
) {}

/** Prepare a group and respond after the target's first delivery. */
class GroupResponsePeerPlan extends Schema.TaggedClass<GroupResponsePeerPlan>()(
  "moltzap.eval-peer-group-response/v1",
  {
    caseId: evaluationCaseId,
    targetName: agentName,
    participantNames: Schema.NonEmptyArray(agentName),
    groupName: Schema.NonEmptyString,
    messages: Schema.NonEmptyArray(Schema.NonEmptyString),
  },
) {}

/** Closed policy universe executed by the distributed peer application. */
// eslint-disable-next-line @typescript-eslint/naming-convention, agent-code-guard/no-exported-brand-constructor -- The container entrypoint decodes this closed boundary schema while case factories expose only decoded plan values.
export const EvaluationPeerApplicationPlan = Schema.Union(
  ReactivePeerPlan,
  OpeningPeerPlan,
  AnnouncementPeerPlan,
  ObserverPeerPlan,
  OrderedGroupPeerPlan,
  GroupResponsePeerPlan,
);
/** Decoded distributed peer application policy. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- the value is the runtime Schema and the type is its decoded result.
export type EvaluationPeerApplicationPlan =
  typeof EvaluationPeerApplicationPlan.Type;

/** Non-secret runtime configuration committed with the RunSpec roster. */
class EvaluationPeerRuntimeConfiguration extends Schema.Class<EvaluationPeerRuntimeConfiguration>(
  "EvaluationPeerRuntimeConfiguration",
)({
  applicationImage: distributedContainerImage,
  plan: EvaluationPeerApplicationPlan,
}) {}

/** Run-scoped secret configuration mounted into exactly one peer container. */
export class EvaluationPeerBootstrap extends Schema.Class<EvaluationPeerBootstrap>(
  "EvaluationPeerBootstrap",
)({
  apiVersion: Schema.Literal("moltzap.eval-peer-bootstrap/v1"),
  agentName,
  agentId,
  agentKey,
  serverUrl: Schema.NonEmptyString,
  plan: EvaluationPeerApplicationPlan,
}) {}

const encodeEvaluationPeerBootstrap = Schema.encodeSync(
  Schema.parseJson(EvaluationPeerBootstrap),
);

function mapNonEmpty<Input, Output>(
  values: NonEmptyReadonlyArray<Input>,
  transform: (value: Input) => Output,
): NonEmptyReadonlyArray<Output> {
  const [first, ...remaining] = values;
  return Object.freeze([transform(first), ...remaining.map(transform)]);
}

/** One completed peer interaction in exact production-protocol order. */
export class PeerExchange extends Schema.Class<PeerExchange>("PeerExchange")({
  observations: Schema.NonEmptyArray(evaluationPeerObservation),
}) {}

/** A bundled code peer could not complete its production-protocol policy. */
export class EvaluationPeerFailed extends Schema.TaggedError<EvaluationPeerFailed>()(
  "EvaluationPeerFailed",
  {
    operation: Schema.Literal(
      "resolve-agent",
      "open-conversation",
      "receive",
      "send",
      "bridge",
    ),
    detail: Schema.NonEmptyString,
  },
) {}

/** The peer application completed its autonomous policy. */
export class EvaluationPeerBridgeCompleted extends Schema.TaggedClass<EvaluationPeerBridgeCompleted>()(
  "moltzap.eval-peer-bridge-completed/v1",
  {
    exchange: PeerExchange,
  },
) {}

/** The peer application terminated its autonomous policy with a typed failure. */
export class EvaluationPeerBridgeFailed extends Schema.TaggedClass<EvaluationPeerBridgeFailed>()(
  "moltzap.eval-peer-bridge-failed/v1",
  {
    failure: EvaluationPeerFailed,
  },
) {}

/** Closed application-to-controller result carried by the peer-specific bridge. */
// eslint-disable-next-line @typescript-eslint/naming-convention, agent-code-guard/no-exported-brand-constructor -- The container bridge and controller attachment share this exact closed transport schema.
export const EvaluationPeerBridgeResult = Schema.Union(
  EvaluationPeerBridgeCompleted,
  EvaluationPeerBridgeFailed,
);
/** Decoded peer-specific bridge result. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- the value is the runtime Schema and the type is its decoded result.
export type EvaluationPeerBridgeResult = typeof EvaluationPeerBridgeResult.Type;

/**
 * Exact principal surface for bundled evaluation peers.
 *
 * The peer is autonomous. Its gateway reports what that policy observed; it
 * does not carry a generic command language or mirror a process transport.
 */
export interface EvaluationPeerGateway {
  readonly exchange: Effect.Effect<PeerExchange, EvaluationPeerFailed>;
}

/**
 * Adapt one decoded application result into the peer's observation-only gateway.
 * @param result Decoded result from the runtime-specific controller bridge.
 * @returns A gateway with no command or social-action surface.
 */
export function evaluationPeerGatewayFromBridge(
  result: Effect.Effect<EvaluationPeerBridgeResult, EvaluationPeerFailed>,
): EvaluationPeerGateway {
  return Object.freeze({
    exchange: result.pipe(
      Effect.flatMap((outcome) =>
        outcome instanceof EvaluationPeerBridgeCompleted
          ? Effect.succeed(outcome.exchange)
          : Effect.fail(outcome.failure),
      ),
    ),
  });
}

/** Distributed runtime shape shared by bundled autonomous peers. */
type EvaluationPeerRuntime = AgentRuntime<
  EvaluationPeerGateway,
  RuntimeAcquisitionFailed,
  typeof EvaluationPeerRuntimeConfiguration
>;

/** Image-independent case-owned peer definition materialized by one cell. */
export interface EvaluationPeerDefinition {
  readonly plan: EvaluationPeerApplicationPlan;
  readonly runtime: (
    applicationImage: DistributedContainerImage,
  ) => EvaluationPeerRuntime;
}

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
          appId: DEFAULT_APP_ID,
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
  context: EvaluationPeerApplicationContext,
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
        appId: DEFAULT_APP_ID,
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

function planPolicy(
  context: EvaluationPeerApplicationContext,
  plan: EvaluationPeerApplicationPlan,
): Effect.Effect<PeerPolicy, EvaluationPeerFailed> {
  if (plan instanceof ReactivePeerPlan) {
    return Effect.succeed(
      reactivePolicy(plan.caseId, plan.targetName, plan.messages),
    );
  }
  if (plan instanceof OpeningPeerPlan) {
    return Effect.succeed(
      openingPolicy(plan.caseId, plan.targetName, plan.text),
    );
  }
  if (plan instanceof AnnouncementPeerPlan) {
    return Effect.succeed(
      sourceAnnouncementPolicy(plan.caseId, plan.targetName, plan.text),
    );
  }
  if (plan instanceof ObserverPeerPlan) {
    return Effect.succeed(observerPolicy(plan.caseId, plan.targetName));
  }
  if (plan instanceof OrderedGroupPeerPlan) {
    return prepareGroup(
      context,
      plan.targetName,
      plan.participantNames,
      plan.groupName,
    ).pipe(
      Effect.map((prepared) =>
        orderedGroupQuestionPolicy(
          plan.caseId,
          prepared,
          plan.sourceName,
          plan.text,
        ),
      ),
    );
  }
  return prepareGroup(
    context,
    plan.targetName,
    plan.participantNames,
    plan.groupName,
  ).pipe(
    Effect.map((prepared) =>
      groupResponsePolicy(plan.caseId, prepared, plan.messages),
    ),
  );
}

/**
 * Execute one decoded peer plan against its production-protocol client.
 * @param context Connected production client, identity, and message stream.
 * @param plan Closed case-owned autonomous interaction policy.
 * @returns The peer's ordered exchange testimony.
 */
export function runEvaluationPeerApplication(
  context: EvaluationPeerApplicationContext,
  plan: EvaluationPeerApplicationPlan,
): Effect.Effect<PeerExchange, EvaluationPeerFailed> {
  return Effect.gen(function* () {
    const inbox = yield* Mailbox.fromStream(context.messages);
    const policy = yield* planPolicy(context, plan);
    return yield* policy(
      Object.freeze({
        agent: context.agent,
        client: context.client,
        inbox,
      }),
    );
  }).pipe(Effect.scoped, Effect.withSpan("evals.peer.application"));
}

function acquisitionFailure(
  agent: string,
  detail: string,
): RuntimeAcquisitionFailed {
  return RuntimeAcquisitionFailed.make({
    runtime: EVALUATION_PEER_RUNTIME_NAME,
    agent,
    detail,
  });
}

function bridgeResultUrl(endpointUrl: string): Option.Option<string> {
  const parsed = Option.liftThrowable((source: string) => new URL(source))(
    endpointUrl,
  );
  return Option.flatMap(parsed, (url) => {
    const isWebSocket = url.protocol === "ws:" || url.protocol === "wss:";
    const hasCredentials = url.username.length > 0 || url.password.length > 0;
    if (!isWebSocket || hasCredentials || url.hostname.length === 0) {
      return Option.none();
    }
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/result";
    url.search = "";
    url.hash = "";
    return Option.some(url.href);
  });
}

function readBridgeResult(
  url: string,
): Effect.Effect<
  Option.Option<EvaluationPeerBridgeResult>,
  EvaluationPeerFailed,
  HttpClient.HttpClient
> {
  return HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(url)),
    Effect.mapError((cause) => failure("bridge", cause)),
    Effect.flatMap((response) => {
      if (response.status === 204) {
        return Effect.succeed(Option.none());
      }
      if (response.status !== 200) {
        return Effect.fail(
          failure(
            "bridge",
            `peer bridge returned HTTP ${String(response.status)}`,
          ),
        );
      }
      return response.json.pipe(
        Effect.mapError((cause) => failure("bridge", cause)),
        Effect.flatMap((body) =>
          Schema.decodeUnknown(EvaluationPeerBridgeResult)(body, {
            onExcessProperty: "error",
          }).pipe(Effect.mapError((cause) => failure("bridge", cause))),
        ),
        Effect.map(Option.some),
      );
    }),
  );
}

function awaitBridgeResult(
  url: string,
): Effect.Effect<EvaluationPeerBridgeResult, EvaluationPeerFailed> {
  const poll: Effect.Effect<
    EvaluationPeerBridgeResult,
    EvaluationPeerFailed,
    HttpClient.HttpClient
  > = Effect.suspend(() =>
    readBridgeResult(url).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.sleep(EVALUATION_PEER_BRIDGE_POLL_INTERVAL).pipe(
              Effect.zipRight(poll),
            ),
          onSome: Effect.succeed,
        }),
      ),
    ),
  );
  return poll.pipe(Effect.provide(NodeHttpClient.layerUndici));
}

function bridgeStopped(
  attachment: DistributedApplicationAttachment,
): Effect.Effect<never, EvaluationPeerFailed> {
  return attachment.stopped.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.fail(
          failure(
            "bridge",
            `peer application stopped before publishing its result: ${Cause.pretty(cause)}`,
          ),
        ),
      onSuccess: (observed) =>
        Effect.fail(
          failure(
            "bridge",
            `peer application stopped before publishing its result: ${String(observed)}`,
          ),
        ),
    }),
  );
}

function attachEvaluationPeer(
  agent: string,
  attachment: DistributedApplicationAttachment,
) {
  return Option.match(bridgeResultUrl(attachment.endpointUrl), {
    onNone: () =>
      Effect.fail(
        acquisitionFailure(
          agent,
          "evaluation peer bridge requires a credential-free WebSocket service URL",
        ),
      ),
    onSome: (url) => {
      const result = awaitBridgeResult(url).pipe(
        Effect.raceFirst(bridgeStopped(attachment)),
      );
      return Effect.succeed(
        Object.freeze({
          gateway: evaluationPeerGatewayFromBridge(result),
          termination: attachment.termination,
        }),
      );
    },
  });
}

function bootstrapSecret<Name extends string>(
  plan: EvaluationPeerApplicationPlan,
  input: AgentRuntimeInput<Name>,
  support: DistributedApplicationSupport,
): DistributedBootstrapSecret {
  const content = encodeEvaluationPeerBootstrap(
    EvaluationPeerBootstrap.make({
      apiVersion: "moltzap.eval-peer-bootstrap/v1",
      agentName: input.agentName,
      agentId: input.connection.agent.id,
      agentKey: input.connection.key,
      serverUrl: httpBaseUrl(input.connection.routerUrl),
      plan,
    }),
  );
  return Object.freeze({
    identity: support.bootstrapSecretIdentity,
    supportImage: support.supportImage,
    files: Object.freeze([
      Object.freeze({
        path: EVALUATION_PEER_BOOTSTRAP_PATH,
        content,
        mode: 0o400,
      }),
    ]),
  });
}

function applicationContainer(
  image: DistributedContainerImage,
): DistributedApplicationContainer {
  return Object.freeze({
    image,
    entrypoint: Object.freeze([
      "node",
      EVALUATION_PEER_APPLICATION_ENTRYPOINT,
      EVALUATION_PEER_BOOTSTRAP_PATH,
    ] as const),
    environment: Object.freeze({ NODE_ENV: "production" }),
    ports: Object.freeze([EVALUATION_PEER_BRIDGE_PORT]),
    resources: EVALUATION_PEER_RESOURCES,
  });
}

function peerRuntime(
  plan: EvaluationPeerApplicationPlan,
  applicationImage: DistributedContainerImage,
): EvaluationPeerRuntime {
  return defineDistributedRuntime({
    name: EVALUATION_PEER_RUNTIME_NAME,
    configuration: {
      schema: EvaluationPeerRuntimeConfiguration,
      value: new EvaluationPeerRuntimeConfiguration({
        applicationImage,
        plan,
      }),
    },
    reservation: Object.freeze({
      image: applicationImage,
      resources: EVALUATION_PEER_RESOURCES,
    }),
    render: (input, support) =>
      Effect.try({
        try: () =>
          Object.freeze({
            applicationContainer: applicationContainer(applicationImage),
            bootstrapSecret: bootstrapSecret(plan, input, support),
            readiness: Object.freeze({
              outputIncludes: EVALUATION_PEER_READY_MARKER,
            }),
            attach: (attachment: DistributedApplicationAttachment) =>
              attachEvaluationPeer(input.agentName, attachment),
          }),
        catch: (cause) => acquisitionFailure(input.agentName, String(cause)),
      }),
  });
}

function peerDefinition(
  plan: EvaluationPeerApplicationPlan,
): EvaluationPeerDefinition {
  Object.freeze(plan);
  return Object.freeze({
    plan,
    runtime: (applicationImage: DistributedContainerImage) =>
      peerRuntime(plan, applicationImage),
  });
}

/**
 * Build an autonomous peer that responds to a target-created conversation.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name the peer accepts messages from.
 * @param messages Ordered peer messages, each followed by one target response.
 * @returns An image-independent definition of the peer interaction.
 */
export function selectedResponsePeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
  messages: NonEmptyReadonlyArray<string>,
) {
  return peerDefinition(
    new ReactivePeerPlan({
      caseId,
      targetName: decodeAgentName(targetName),
      messages: mapNonEmpty(messages, (message) => message),
    }),
  );
}

/**
 * Build an autonomous context peer whose response is not selected for grading.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name the peer accepts messages from.
 * @param messages Ordered peer messages, each followed by one target response.
 * @returns An image-independent definition of the peer interaction.
 */
export function contextPeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
  messages: NonEmptyReadonlyArray<string>,
) {
  return selectedResponsePeerRuntime(caseId, targetName, messages);
}

/**
 * Build the identity-awareness peer that creates the social workspace.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name the peer contacts.
 * @param text Initial peer message.
 * @returns An image-independent definition of the peer interaction.
 */
export function openingPeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
  text: string,
) {
  return peerDefinition(
    new OpeningPeerPlan({
      caseId,
      targetName: decodeAgentName(targetName),
      text,
    }),
  );
}

/**
 * Build a source peer that contributes to a target-created group.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name whose first message identifies the group.
 * @param text Source announcement sent into that exact conversation.
 * @returns An image-independent definition of the peer interaction.
 */
export function announcementPeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
  text: string,
) {
  return peerDefinition(
    new AnnouncementPeerPlan({
      caseId,
      targetName: decodeAgentName(targetName),
      text,
    }),
  );
}

/**
 * Build an observer that records the target's first delivered message.
 * @param caseId Evaluation case identity copied into endpoint testimony.
 * @param targetName Roster name whose first delivery is observed.
 * @returns An image-independent definition of the peer interaction.
 */
export function observerPeerRuntime(
  caseId: EvaluationCaseId,
  targetName: string,
) {
  return peerDefinition(
    new ObserverPeerPlan({
      caseId,
      targetName: decodeAgentName(targetName),
    }),
  );
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
 * @returns An image-independent definition of the peer interaction.
 */
export function orderedGroupPeerRuntime(
  options: OrderedGroupPeerOptions,
): EvaluationPeerDefinition {
  return peerDefinition(
    new OrderedGroupPeerPlan({
      caseId: options.caseId,
      targetName: decodeAgentName(options.targetName),
      sourceName: decodeAgentName(options.sourceName),
      participantNames: mapNonEmpty(options.participantNames, decodeAgentName),
      groupName: options.groupName,
      text: options.text,
    }),
  );
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
 * @returns An image-independent definition of the peer interaction.
 */
export function groupResponsePeerRuntime(
  options: GroupResponsePeerOptions,
): EvaluationPeerDefinition {
  return peerDefinition(
    new GroupResponsePeerPlan({
      caseId: options.caseId,
      targetName: decodeAgentName(options.targetName),
      participantNames: mapNonEmpty(options.participantNames, decodeAgentName),
      groupName: options.groupName,
      messages: mapNonEmpty(options.messages, (message) => message),
    }),
  );
}
