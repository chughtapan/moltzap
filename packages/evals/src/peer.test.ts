import { assert, beforeEach, it } from "@effect/vitest";
import { agentConversationCreate } from "@moltzap/protocol/conversation";
import {
  agentsList,
  type AgentCard,
  type AgentId,
} from "@moltzap/protocol/identity";
import {
  messagesSend,
  type Message,
  type MessageReceivedNotification,
} from "@moltzap/protocol/message";
import {
  agentId,
  agentName,
  conversationId,
  messageId,
} from "@moltzap/protocol/testing";
import { Array as Arr, Deferred, Effect, Fiber, Schema, Stream } from "effect";
import { CodePeerMessageReceived, CodePeerMessageSent } from "./events.js";
import { decodeEvaluationCaseId } from "./model.js";
import {
  EvaluationPeerBridgeCompleted,
  EvaluationPeerBridgeFailed,
  EvaluationPeerBridgeResult,
  EvaluationPeerFailed,
  PeerExchange,
  announcementPeerRuntime,
  evaluationPeerGatewayFromBridge,
  observerPeerRuntime,
  orderedGroupPeerRuntime,
  runEvaluationPeerApplication,
  type EvaluationPeerApplicationContext,
  type EvaluationPeerApplicationPlan,
} from "./peer.js";

// @agent-code-guard/regression-only: these deterministic protocol fakes pin peer ordering and bridge projection against previously observed regressions.

interface ClientCall {
  readonly definition: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

type DeliveryEmitter = (
  notification: MessageReceivedNotification,
) => Effect.Effect<void, string>;

interface FakeClientState {
  agents: readonly AgentCard[];
  received?: Stream.Stream<MessageReceivedNotification, unknown>;
  conversationOpened?: Deferred.Deferred<undefined>;
  readonly calls: ClientCall[];
  readonly emitters: DeliveryEmitter[];
  readonly sendDeliveries: MessageReceivedNotification[];
  readonly sendResults: Array<{ readonly message: Message }>;
  readonly sendPermissions: Set<string>;
  readonly sendCompletions: Array<Deferred.Deferred<undefined>>;
}

const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000821");

const clientState: FakeClientState = {
  agents: [],
  received: undefined,
  conversationOpened: undefined,
  calls: [],
  emitters: [],
  sendDeliveries: [],
  sendResults: [],
  sendPermissions: new Set(),
  sendCompletions: [],
};

function deliver(
  notification: MessageReceivedNotification,
): Effect.Effect<void, string> {
  const emitter = clientState.emitters.at(-1);
  return emitter === undefined
    ? Effect.dieMessage("the peer message stream is not being consumed")
    : emitter(notification);
}

function fakeSend(
  payload: Readonly<Record<string, unknown>>,
): Effect.Effect<{ readonly message: Message }, string> {
  if (!clientState.sendPermissions.has(messagesSend.name)) {
    return Effect.fail("peer sent before its ordered inputs arrived");
  }
  const result = clientState.sendResults.shift();
  if (result === undefined) {
    return Effect.fail("test did not install a send result");
  }
  const responses = clientState.sendDeliveries.splice(0);
  const completion = clientState.sendCompletions.shift();
  const deliverResponses = Effect.forEach(responses, deliver, {
    concurrency: 1,
    discard: true,
  });
  const signal =
    completion === undefined
      ? Effect.void
      : Deferred.succeed(completion, undefined).pipe(Effect.asVoid);
  return deliverResponses.pipe(
    Effect.zipRight(signal),
    Effect.as(result),
    Effect.tap(() =>
      Effect.sync(() => {
        clientState.calls.push({
          definition: messagesSend.name,
          payload,
        });
      }),
    ),
  );
}

function fakeCallDefinition(
  definition: { readonly name: string },
  payload: Readonly<Record<string, unknown>>,
) {
  if (definition.name === agentsList.name) {
    return Effect.succeed({ agents: clientState.agents });
  }
  if (definition.name === messagesSend.name) {
    return fakeSend(payload);
  }
  if (definition.name === agentConversationCreate.name) {
    clientState.calls.push({
      definition: agentConversationCreate.name,
      payload,
    });
    const opened = clientState.conversationOpened;
    return (
      opened === undefined
        ? Effect.void
        : Deferred.succeed(opened, undefined).pipe(Effect.asVoid)
    ).pipe(
      Effect.as({
        conversation: { id: CONVERSATION_ID },
      }),
    );
  }
  return Effect.fail(`unexpected RPC ${definition.name}`);
}

// eslint-disable-next-line agent-code-guard/require-assertion-rationale -- This protocol fake deliberately implements only the three RPC definitions exercised by peer plans; each branch is checked by definition name and returns that definition's fixture shape.
const fakeClient = Object.freeze({
  callDefinition: fakeCallDefinition,
}) as EvaluationPeerApplicationContext["client"];

const CASE_ID = decodeEvaluationCaseId("EVAL-006");
const TARGET_NAME = "evaluation-target";
const SOURCE_NAME = "evaluation-source";
const QUESTION_NAME = "evaluation-question";
const OBSERVER_NAME = "evaluation-observer";
const TARGET_ID = agentId("00000000-0000-4000-8000-000000000801");
const SOURCE_ID = agentId("00000000-0000-4000-8000-000000000802");
const QUESTION_ID = agentId("00000000-0000-4000-8000-000000000803");
const OTHER_ID = agentId("00000000-0000-4000-8000-000000000804");
const OBSERVER_ID = agentId("00000000-0000-4000-8000-000000000805");
const OTHER_CONVERSATION_ID = conversationId(
  "00000000-0000-4000-8000-000000000822",
);
const CREATED_AT = "2026-07-29T00:00:00.000Z";
const SOURCE_ANNOUNCEMENT = "I have been working on data pipelines.";
const GROUP_QUESTION = "What has everyone been working on? Keep it brief.";
const GROUP_NAME = "evaluation-eval-006";
const SOURCE_AGENT_NAME = agentName(SOURCE_NAME);
beforeEach(() => {
  clientState.agents = [];
  clientState.received = undefined;
  clientState.conversationOpened = undefined;
  clientState.calls.length = 0;
  clientState.emitters.length = 0;
  clientState.sendDeliveries.length = 0;
  clientState.sendResults.length = 0;
  clientState.sendPermissions.clear();
  clientState.sendCompletions.length = 0;
});

function receivedStream(
  ready: Deferred.Deferred<undefined>,
): Stream.Stream<MessageReceivedNotification> {
  return Stream.asyncEffect<MessageReceivedNotification>((emit) => {
    const emitter: DeliveryEmitter = (notification) =>
      Effect.tryPromise({
        try: () => emit.single(notification),
        catch: (cause) => String(cause),
      }).pipe(Effect.asVoid);
    return Effect.sync(() => {
      clientState.emitters.push(emitter);
    }).pipe(Effect.zipRight(Deferred.succeed(ready, undefined)), Effect.asVoid);
  });
}

function card(name: string, id: AgentId): AgentCard {
  return {
    id,
    name: agentName(name),
    status: "active",
  };
}

function notification(
  id: string,
  senderId: AgentId,
  text: string,
  selectedConversationId = CONVERSATION_ID,
): MessageReceivedNotification {
  return {
    message: {
      id: messageId(id),
      conversationId: selectedConversationId,
      senderId,
      parts: [{ type: "text", text }],
      createdAt: CREATED_AT,
    },
  };
}

function sentMessage(id: string, senderId: AgentId, text: string): Message {
  return {
    id: messageId(id),
    conversationId: CONVERSATION_ID,
    senderId,
    parts: [{ type: "text", text }],
    createdAt: CREATED_AT,
  };
}

function messageCalls(): readonly ClientCall[] {
  return clientState.calls.filter(
    (call) => call.definition === messagesSend.name,
  );
}

const test = it.effect;

function expectedSend(text: string): readonly ClientCall[] {
  return [
    {
      definition: messagesSend.name,
      payload: {
        conversationId: CONVERSATION_ID,
        parts: [{ type: "text", text }],
      },
    },
  ];
}

function installFastResponses(): MessageReceivedNotification {
  clientState.sendDeliveries.push(
    notification(
      "00000000-0000-4000-8000-000000000847",
      SOURCE_ID,
      "not a target response",
    ),
    notification(
      "00000000-0000-4000-8000-000000000848",
      TARGET_ID,
      "target response in another conversation",
      OTHER_CONVERSATION_ID,
    ),
  );
  const response = notification(
    "00000000-0000-4000-8000-000000000849",
    TARGET_ID,
    "I have been working on the simulator core.",
  );
  clientState.sendDeliveries.push(response);
  return response;
}

const startPeer = Effect.fn(function* (
  plan: EvaluationPeerApplicationPlan,
  name: string,
  id: AgentId,
) {
  const ready = yield* Deferred.make<undefined>();
  clientState.received = receivedStream(ready);
  const running = yield* runEvaluationPeerApplication(
    {
      agent: Object.freeze({ name, id }),
      messages: clientState.received,
      client: fakeClient,
    },
    plan,
  ).pipe(Effect.forkScoped);
  yield* Deferred.await(ready);
  return Object.freeze({ exchange: Fiber.join(running) });
});

const acquireSourcePeer = Effect.fn(function* () {
  clientState.agents = [card(TARGET_NAME, TARGET_ID)];
  clientState.sendResults.push({
    message: sentMessage(
      "00000000-0000-4000-8000-000000000831",
      SOURCE_ID,
      SOURCE_ANNOUNCEMENT,
    ),
  });
  const definition = announcementPeerRuntime(
    CASE_ID,
    TARGET_NAME,
    SOURCE_ANNOUNCEMENT,
  );
  return yield* startPeer(definition.plan, SOURCE_NAME, SOURCE_ID);
});

const acquireQuestionPeer = Effect.fn(function* () {
  clientState.agents = [
    card(TARGET_NAME, TARGET_ID),
    card(SOURCE_NAME, SOURCE_ID),
    card(OBSERVER_NAME, OBSERVER_ID),
  ];
  const sendCompleted = yield* Deferred.make<undefined>();
  const conversationOpened = yield* Deferred.make<undefined>();
  clientState.conversationOpened = conversationOpened;
  clientState.sendCompletions.push(sendCompleted);
  const response = installFastResponses();
  clientState.sendResults.push({
    message: sentMessage(
      "00000000-0000-4000-8000-000000000841",
      QUESTION_ID,
      GROUP_QUESTION,
    ),
  });
  const definition = orderedGroupPeerRuntime({
    caseId: CASE_ID,
    targetName: TARGET_NAME,
    sourceName: SOURCE_NAME,
    participantNames: [SOURCE_NAME, OBSERVER_NAME],
    groupName: GROUP_NAME,
    text: GROUP_QUESTION,
  });
  const gateway = yield* startPeer(definition.plan, QUESTION_NAME, QUESTION_ID);
  yield* Deferred.await(conversationOpened);
  return { gateway, response, sendCompleted };
});

const acquireObserverPeer = Effect.fn(function* () {
  clientState.agents = [card(TARGET_NAME, TARGET_ID)];
  const definition = observerPeerRuntime(CASE_ID, TARGET_NAME);
  return yield* startPeer(definition.plan, OBSERVER_NAME, OBSERVER_ID);
});

function assertSourceExchange(
  exchange: PeerExchange,
  contact: MessageReceivedNotification,
): void {
  assert.lengthOf(exchange.observations, 2);
  const [received, sent] = exchange.observations;
  assert.instanceOf(received, CodePeerMessageReceived);
  assert.instanceOf(sent, CodePeerMessageSent);
  assert.strictEqual(received.messageId, contact.message.id);
  assert.strictEqual(sent.agentId, SOURCE_ID);
  assert.deepStrictEqual(messageCalls(), expectedSend(SOURCE_ANNOUNCEMENT));
}

const sourcePolicyTest = Effect.fn(function* () {
  const gateway = yield* acquireSourcePeer();
  yield* deliver(
    notification(
      "00000000-0000-4000-8000-000000000832",
      OTHER_ID,
      "unrelated traffic",
    ),
  );
  yield* Effect.yieldNow();
  assert.lengthOf(messageCalls(), 0);
  clientState.sendPermissions.add(messagesSend.name);
  const contact = notification(
    "00000000-0000-4000-8000-000000000833",
    TARGET_ID,
    "Join this group.",
  );
  yield* deliver(contact);
  const exchange = yield* gateway.exchange;
  assertSourceExchange(exchange, contact);
});

const observerPolicyTest = Effect.fn(function* () {
  const gateway = yield* acquireObserverPeer();
  yield* deliver(
    notification(
      "00000000-0000-4000-8000-000000000834",
      OTHER_ID,
      "unrelated observer traffic",
    ),
  );
  const contact = notification(
    "00000000-0000-4000-8000-000000000835",
    TARGET_ID,
    "Observe this group.",
  );
  yield* deliver(contact);
  const exchange = yield* gateway.exchange;
  assert.lengthOf(exchange.observations, 1);
  const [received] = exchange.observations;
  assert.instanceOf(received, CodePeerMessageReceived);
  assert.strictEqual(received.messageId, contact.message.id);
  assert.lengthOf(messageCalls(), 0);
});

const publishQuestionPreamble = Effect.fn(function* () {
  yield* deliver(
    notification(
      "00000000-0000-4000-8000-000000000842",
      SOURCE_ID,
      "source traffic before the target identifies a group",
      OTHER_CONVERSATION_ID,
    ),
  );
  const contact = notification(
    "00000000-0000-4000-8000-000000000843",
    TARGET_ID,
    "Join this group.",
  );
  yield* deliver(contact);
  yield* deliver(
    notification(
      "00000000-0000-4000-8000-000000000844",
      TARGET_ID,
      "target chatter is not the source announcement",
    ),
  );
  yield* deliver(
    notification(
      "00000000-0000-4000-8000-000000000845",
      SOURCE_ID,
      "source traffic in another conversation",
      OTHER_CONVERSATION_ID,
    ),
  );
  yield* Effect.yieldNow();
  return contact;
});

function assertQuestionExchange(
  exchange: PeerExchange,
  contact: MessageReceivedNotification,
  source: MessageReceivedNotification,
  response: MessageReceivedNotification,
): void {
  assert.lengthOf(exchange.observations, 4);
  const [receivedContact, receivedSource, sentQuestion] = exchange.observations;
  assert.instanceOf(receivedContact, CodePeerMessageReceived);
  assert.instanceOf(receivedSource, CodePeerMessageReceived);
  assert.instanceOf(sentQuestion, CodePeerMessageSent);
  assert.strictEqual(receivedContact.messageId, contact.message.id);
  assert.strictEqual(receivedSource.messageId, source.message.id);
  assert.strictEqual(sentQuestion.agentId, QUESTION_ID);
  const finalObservation = Arr.lastNonEmpty(exchange.observations);
  assert.instanceOf(finalObservation, CodePeerMessageReceived);
  assert.strictEqual(finalObservation.messageId, response.message.id);
  assert.strictEqual(finalObservation.senderId, TARGET_ID);
  assert.deepStrictEqual(messageCalls(), expectedSend(GROUP_QUESTION));
}

const orderedGroupPolicyTest = Effect.fn(function* () {
  const fixture = yield* acquireQuestionPeer();
  assert.deepStrictEqual(
    clientState.calls.filter(
      (call) => call.definition === agentConversationCreate.name,
    ),
    [
      {
        definition: agentConversationCreate.name,
        payload: {
          name: GROUP_NAME,
          participants: [TARGET_ID, SOURCE_ID, OBSERVER_ID],
        },
      },
    ],
  );
  const contact = yield* publishQuestionPreamble();
  assert.lengthOf(messageCalls(), 0);
  clientState.sendPermissions.add(messagesSend.name);
  const source = notification(
    "00000000-0000-4000-8000-000000000846",
    SOURCE_ID,
    SOURCE_ANNOUNCEMENT,
  );
  yield* deliver(source);
  yield* Deferred.await(fixture.sendCompleted);
  const exchange = yield* fixture.gateway.exchange;
  assertQuestionExchange(exchange, contact, source, fixture.response);
});

const completedBridgeTest = Effect.fn(function* () {
  const exchange = new PeerExchange({
    observations: [
      CodePeerMessageReceived.make({
        caseId: CASE_ID,
        agentName: SOURCE_AGENT_NAME,
        agentId: SOURCE_ID,
        conversationId: CONVERSATION_ID,
        messageId: messageId("00000000-0000-4000-8000-000000000849"),
        senderId: TARGET_ID,
        parts: [{ type: "text", text: "bridge observation" }],
      }),
    ],
  });
  const completed = EvaluationPeerBridgeCompleted.make({ exchange });
  const encoded = yield* Schema.encode(EvaluationPeerBridgeResult)(completed);
  const decoded = yield* Schema.decode(EvaluationPeerBridgeResult)(encoded);
  const gateway = evaluationPeerGatewayFromBridge(Effect.succeed(decoded));

  assert.deepStrictEqual(yield* gateway.exchange, exchange);
});

const failedBridgeTest = Effect.fn(function* () {
  const failure = EvaluationPeerFailed.make({
    operation: "bridge",
    detail: "peer application terminated before publishing its exchange",
  });
  const encoded = yield* Schema.encode(EvaluationPeerBridgeResult)(
    EvaluationPeerBridgeFailed.make({ failure }),
  );
  const decoded = yield* Schema.decode(EvaluationPeerBridgeResult)(encoded);
  const gateway = evaluationPeerGatewayFromBridge(Effect.succeed(decoded));
  const observed = yield* gateway.exchange.pipe(
    Effect.match({
      onFailure: (value) => ({ failure: value }),
      onSuccess: () => ({ failure: undefined }),
    }),
  );

  assert.instanceOf(observed.failure, EvaluationPeerFailed);
  assert.strictEqual(observed.failure?.operation, failure.operation);
  assert.strictEqual(observed.failure?.detail, failure.detail);
});

test("the source announces only after target contact and in that conversation", () =>
  Effect.scoped(sourcePolicyTest()));

test("the observer records the first target delivery without sending", () =>
  Effect.scoped(observerPolicyTest()));

test("the question preserves order and buffers a response received before send returns", () =>
  Effect.scoped(orderedGroupPolicyTest()));
test("the peer bridge round-trips and projects a completed exchange", () =>
  completedBridgeTest());
test("the peer bridge projects a typed application failure", () =>
  failedBridgeTest());
