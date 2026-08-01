import { assert, beforeEach, it } from "@effect/vitest";
import { agentConversationCreate } from "@moltzap/protocol/conversation";
import {
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
import { serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentName,
  agentKeyString,
  conversationId,
  messageId,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { Array as Arr, Deferred, Effect, Stream } from "effect";
import { vi } from "vitest";
import type { AgentConnection } from "@moltzap/simulator";
import { makeAgentHandle } from "@moltzap/simulator/network";
import { CodePeerMessageReceived, CodePeerMessageSent } from "./events.js";
import { decodeEvaluationCaseId } from "./model.js";
import type { PeerExchange } from "./peer.js";

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
  readonly calls: ClientCall[];
  readonly emitters: DeliveryEmitter[];
  readonly sendDeliveries: MessageReceivedNotification[];
  readonly sendResults: Array<{ readonly message: Message }>;
  readonly sendPermissions: Set<string>;
  readonly sendCompletions: Array<Deferred.Deferred<undefined>>;
}

const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000821");

const clientState = vi.hoisted(
  (): FakeClientState => ({
    agents: [],
    received: undefined,
    calls: [],
    emitters: [],
    sendDeliveries: [],
    sendResults: [],
    sendPermissions: new Set(),
    sendCompletions: [],
  }),
);

interface FakeRuntimeContext {
  readonly agent: AgentConnection["agent"];
  readonly messages: Stream.Stream<MessageReceivedNotification, unknown>;
  readonly client: {
    readonly callDefinition: typeof fakeCallDefinition;
  };
}

interface FakeBuiltAgent {
  readonly gateway: unknown;
  readonly behavior: Effect.Effect<void, unknown>;
}

interface FakeRuntimeOptions {
  readonly build: (
    context: FakeRuntimeContext,
  ) => Effect.Effect<FakeBuiltAgent, unknown>;
}

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
    return Effect.succeed({
      conversation: { id: CONVERSATION_ID },
    });
  }
  return Effect.fail(`unexpected RPC ${definition.name}`);
}

function fakeAcquire(
  options: FakeRuntimeOptions,
  input: { readonly connection: AgentConnection },
) {
  return Effect.gen(function* () {
    const messages = clientState.received;
    if (messages === undefined) {
      return yield* Effect.dieMessage("test did not install a message stream");
    }
    const built = yield* options.build({
      agent: input.connection.agent,
      messages,
      client: { callDefinition: fakeCallDefinition },
    });
    yield* built.behavior.pipe(Effect.forkScoped);
    yield* Effect.yieldNow();
    return {
      gateway: built.gateway,
      termination: Effect.never,
    };
  });
}

function fakeEffectRuntime(options: FakeRuntimeOptions) {
  return {
    acquire: (input: { readonly connection: AgentConnection }) =>
      fakeAcquire(options, input),
  };
}

vi.doMock("@moltzap/simulator/runtime", () => ({
  effectRuntime: fakeEffectRuntime,
}));

const peerModule = Effect.tryPromise({
  try: () => import("./peer.js"),
  catch: (cause) => String(cause),
});

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
const ROUTER_URL = serverBaseUrl("ws://127.0.0.1:31890");
const AGENT_KEY = redactedAgentKey(agentKeyString(801));
const CREATED_AT = "2026-07-29T00:00:00.000Z";
const SOURCE_ANNOUNCEMENT = "I have been working on data pipelines.";
const GROUP_QUESTION = "What has everyone been working on? Keep it brief.";
const GROUP_NAME = "evaluation-eval-006";
beforeEach(() => {
  clientState.agents = [];
  clientState.received = undefined;
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

function connection<Name extends string>(
  name: Name,
  id: AgentId,
): AgentConnection<Name> {
  return {
    agent: makeAgentHandle(name, id),
    key: AGENT_KEY,
    routerUrl: ROUTER_URL,
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

const acquireSourcePeer = Effect.fn(function* () {
  const peers = yield* peerModule;
  const ready = yield* Deferred.make<undefined>();
  clientState.received = receivedStream(ready);
  clientState.agents = [card(TARGET_NAME, TARGET_ID)];
  clientState.sendResults.push({
    message: sentMessage(
      "00000000-0000-4000-8000-000000000831",
      SOURCE_ID,
      SOURCE_ANNOUNCEMENT,
    ),
  });
  const running = yield* peers
    .announcementPeerRuntime(CASE_ID, TARGET_NAME, SOURCE_ANNOUNCEMENT)
    .acquire({
      agentName: agentName(SOURCE_NAME),
      connection: connection(SOURCE_NAME, SOURCE_ID),
    });
  yield* Deferred.await(ready);
  return running.gateway;
});

const acquireQuestionPeer = Effect.fn(function* () {
  const peers = yield* peerModule;
  const ready = yield* Deferred.make<undefined>();
  clientState.received = receivedStream(ready);
  clientState.agents = [
    card(TARGET_NAME, TARGET_ID),
    card(SOURCE_NAME, SOURCE_ID),
    card(OBSERVER_NAME, OBSERVER_ID),
  ];
  const sendCompleted = yield* Deferred.make<undefined>();
  clientState.sendCompletions.push(sendCompleted);
  const response = installFastResponses();
  clientState.sendResults.push({
    message: sentMessage(
      "00000000-0000-4000-8000-000000000841",
      QUESTION_ID,
      GROUP_QUESTION,
    ),
  });
  const running = yield* peers
    .orderedGroupPeerRuntime({
      caseId: CASE_ID,
      targetName: TARGET_NAME,
      sourceName: SOURCE_NAME,
      participantNames: [SOURCE_NAME, OBSERVER_NAME],
      groupName: GROUP_NAME,
      text: GROUP_QUESTION,
    })
    .acquire({
      agentName: agentName(QUESTION_NAME),
      connection: connection(QUESTION_NAME, QUESTION_ID),
    });
  yield* Deferred.await(ready);
  return { gateway: running.gateway, response, sendCompleted };
});

const acquireObserverPeer = Effect.fn(function* () {
  const peers = yield* peerModule;
  const ready = yield* Deferred.make<undefined>();
  clientState.received = receivedStream(ready);
  clientState.agents = [card(TARGET_NAME, TARGET_ID)];
  const running = yield* peers
    .observerPeerRuntime(CASE_ID, TARGET_NAME)
    .acquire({
      agentName: agentName(OBSERVER_NAME),
      connection: connection(OBSERVER_NAME, OBSERVER_ID),
    });
  yield* Deferred.await(ready);
  return running.gateway;
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
          appId: DEFAULT_APP_ID,
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

test("the source announces only after target contact and in that conversation", () =>
  Effect.scoped(sourcePolicyTest()));

test("the observer records the first target delivery without sending", () =>
  Effect.scoped(observerPolicyTest()));

test("the question preserves order and buffers a response received before send returns", () =>
  Effect.scoped(orderedGroupPolicyTest()));
