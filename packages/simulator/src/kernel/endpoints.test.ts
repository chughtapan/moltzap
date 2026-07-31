import { assert, effect as test } from "@effect/vitest";
import type { MessageId } from "@moltzap/protocol/conversation";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import {
  agentId,
  conversationId,
  messageId,
  redactedAgentKey,
  taskId,
} from "@moltzap/protocol/testing";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  PubSub,
  Schema,
  Stream,
} from "effect";
import {
  ConversationOpened,
  type endpointEvents,
  EndpointMessageReceived,
  EndpointMessageSent,
} from "../events/core.js";
import type { LedgerWriter } from "../ledger/live.js";
import { LedgerStorageError } from "../ledger/storage.js";
import {
  makeAgentHandle,
  makeParticipantHandle,
  makeRouterStopReport,
  networkFailure,
  type EndpointTransport,
  type ReceivedMessage,
  type Router,
} from "../network.js";
import { makeNetworkService } from "./endpoints.js";

type EndpointEventWriter = LedgerWriter<typeof endpointEvents>;
const PROBE_ID = agentId("00000000-0000-4000-8000-000000000001");
const TARGET_ID = agentId("00000000-0000-4000-8000-000000000002");
const KEY = redactedAgentKey(
  "moltzap_agent_0000000000000000_000000000000000000000000000000000000000000000000",
);
const ROUTER_URL = Schema.decodeSync(serverBaseUrlSchema)(
  "http://127.0.0.1:43100",
);
const TASK_ID = taskId("00000000-0000-4000-8000-000000000003");
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000004");
const RECEIVED_ID = messageId("00000000-0000-4000-8000-000000000005");
const SECOND_RECEIVED_ID = messageId("00000000-0000-4000-8000-000000000007");
const SENT_ID = messageId("00000000-0000-4000-8000-000000000006");

type EndpointEvent =
  | ConversationOpened
  | EndpointMessageReceived
  | EndpointMessageSent;

function writer(events: EndpointEvent[]): EndpointEventWriter {
  return {
    write: ({ event }) =>
      Effect.sync(() => {
        events.push(event);
        return {
          runId: "observed-network-test",
          eventId: `event-${String(events.length)}`,
          logicalSequence: events.length - 1,
          elapsedNanos: 0n,
          observedAt: 0,
          producer: "kernel.endpoint",
          event,
        };
      }),
  };
}

function receivedMessage(id: MessageId, text: string): ReceivedMessage {
  return {
    taskId: TASK_ID,
    message: {
      id,
      conversationId: CONVERSATION_ID,
      senderId: TARGET_ID,
      parts: [{ type: "text", text }],
      createdAt: "2026-07-28T00:00:00.000Z",
    },
  };
}

interface AttachmentCount {
  value: number;
}

function sendMessage(sends?: AttachmentCount): EndpointTransport["send"] {
  return (...[, conversationId, parts]) =>
    Effect.sync(() => {
      if (sends !== undefined) {
        sends.value += 1;
      }
      return {
        id: SENT_ID,
        conversationId,
        senderId: PROBE_ID,
        parts,
        createdAt: "2026-07-28T00:00:00.000Z",
      };
    });
}

function router(
  received: Stream.Stream<ReceivedMessage>,
  attachments: AttachmentCount,
  sends?: AttachmentCount,
): Router {
  return {
    address: ROUTER_URL,
    stopped: Effect.succeed(makeRouterStopReport([])),
    attachAgent: (name) =>
      Effect.succeed({
        agent: makeAgentHandle(name, TARGET_ID),
        key: KEY,
        routerUrl: ROUTER_URL,
      }),
    attachEndpoint: (name) =>
      Effect.sync(() => {
        attachments.value += 1;
        return {
          participant: makeParticipantHandle(name, PROBE_ID),
          transport: {
            received,
            openConversation: () =>
              Effect.succeed({
                taskId: TASK_ID,
                conversationId: CONVERSATION_ID,
              }),
            send: sendMessage(sends),
          },
        };
      }),
  };
}

function observedNetworkTest() {
  return Effect.gen(function* () {
    const deliveries = yield* PubSub.unbounded<ReceivedMessage>();
    const received = yield* Stream.fromPubSub(deliveries, {
      scoped: true,
    });
    const events: EndpointEvent[] = [];
    const attachments = { value: 0 };
    const network = yield* makeNetworkService(
      router(received, attachments),
      writer(events),
    );
    const probe = yield* network.endpoint("probe");
    const sameProbe = yield* network.endpoint("probe");
    const socket = yield* probe.open(
      makeParticipantHandle("target", TARGET_ID),
    );
    const endpointMessagesFiber = yield* probe
      .messages()
      .pipe(Stream.take(2), Stream.runCollect, Effect.fork);
    yield* Effect.yieldNow();
    yield* PubSub.publishAll(deliveries, [
      receivedMessage(RECEIVED_ID, "first"),
      receivedMessage(SECOND_RECEIVED_ID, "second"),
    ]);
    const endpointMessages = yield* Fiber.join(endpointMessagesFiber);
    const first = yield* socket.receive();
    const second = yield* socket.receive();
    yield* socket.send("request");
    assert.strictEqual(sameProbe, probe);
    assert.strictEqual(attachments.value, 1);
    assert.strictEqual(endpointMessages.length, 2);
    assert.strictEqual(first.message.id, RECEIVED_ID);
    assert.strictEqual(second.message.id, SECOND_RECEIVED_ID);
    assert.deepStrictEqual(
      events.map((event) => event._tag),
      [
        ConversationOpened._tag,
        EndpointMessageReceived._tag,
        EndpointMessageReceived._tag,
        EndpointMessageSent._tag,
      ],
    );
  });
}

// @agent-code-guard/regression-only: controlled streams and writers expose exact endpoint evidence, cursor, and fatal-ledger behavior
test("observes one ingress and advances ordered endpoint and conversation inboxes", () =>
  Effect.scoped(observedNetworkTest()));

test("coalesces concurrent attachment of the same endpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const attachmentStarted = yield* Deferred.make<undefined>();
      const releaseAttachment = yield* Deferred.make<undefined>();
      const callersStarted = yield* Deferred.make<undefined>();
      const attachments = { value: 0 };
      const attempts = { value: 0 };
      const callers = { value: 0 };
      const baseRouter = router(Stream.never, attachments);
      const gatedRouter: Router = {
        ...baseRouter,
        attachEndpoint: (name, agentName) =>
          Effect.sync(() => {
            attempts.value += 1;
          }).pipe(
            Effect.zipRight(
              Deferred.succeed(attachmentStarted, undefined).pipe(
                Effect.asVoid,
              ),
            ),
            Effect.zipRight(Deferred.await(releaseAttachment)),
            Effect.zipRight(baseRouter.attachEndpoint(name, agentName)),
          ),
      };
      const network = yield* makeNetworkService(gatedRouter, writer([]));
      const acquire = Effect.sync(() => {
        callers.value += 1;
        return callers.value;
      }).pipe(
        Effect.tap((count) =>
          count === 2
            ? Deferred.succeed(callersStarted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.zipRight(network.endpoint("probe")),
      );
      const endpoints = yield* Effect.all([acquire, acquire], {
        concurrency: 2,
      }).pipe(Effect.fork);

      yield* Deferred.await(callersStarted);
      yield* Deferred.await(attachmentStarted);
      yield* Effect.yieldNow();
      assert.strictEqual(attempts.value, 1);

      yield* Deferred.succeed(releaseAttachment, undefined);
      const [first, second] = yield* Fiber.join(endpoints);
      assert.strictEqual(first, second);
      assert.strictEqual(attachments.value, 1);
    }),
  ));

interface AttachmentRetryGates {
  readonly firstStarted: Deferred.Deferred<undefined>;
  readonly releaseFirst: Deferred.Deferred<undefined>;
  readonly retryStarted: Deferred.Deferred<undefined>;
  readonly releaseRetry: Deferred.Deferred<undefined>;
}

function retryingRouter(
  baseRouter: Router,
  attempts: AttachmentCount,
  gates: AttachmentRetryGates,
): Router {
  return {
    ...baseRouter,
    attachEndpoint: (name, agentName) =>
      Effect.sync(() => {
        attempts.value += 1;
        return attempts.value;
      }).pipe(
        Effect.flatMap((attempt) =>
          attempt === 1
            ? Deferred.succeed(gates.firstStarted, undefined).pipe(
                Effect.zipRight(Deferred.await(gates.releaseFirst)),
                Effect.zipRight(
                  Effect.fail(
                    networkFailure(
                      "attach-endpoint",
                      "temporarily unavailable",
                    ),
                  ),
                ),
              )
            : Deferred.succeed(gates.retryStarted, undefined).pipe(
                Effect.zipRight(Deferred.await(gates.releaseRetry)),
                Effect.zipRight(baseRouter.attachEndpoint(name, agentName)),
              ),
        ),
      ),
  };
}

function failedAttachmentRetryTest() {
  return Effect.gen(function* () {
    const gates: AttachmentRetryGates = {
      firstStarted: yield* Deferred.make<undefined>(),
      releaseFirst: yield* Deferred.make<undefined>(),
      retryStarted: yield* Deferred.make<undefined>(),
      releaseRetry: yield* Deferred.make<undefined>(),
    };
    const waiterStarted = yield* Deferred.make<undefined>();
    const attachments = { value: 0 };
    const attempts = { value: 0 };
    const baseRouter = router(Stream.never, attachments);
    const network = yield* makeNetworkService(
      retryingRouter(baseRouter, attempts, gates),
      writer([]),
    );
    const retrying = yield* network.endpoint("probe").pipe(
      Effect.catchAll(() => network.endpoint("probe")),
      Effect.fork,
    );
    yield* Deferred.await(gates.firstStarted);
    const lateWaiter = yield* Deferred.succeed(waiterStarted, undefined).pipe(
      Effect.zipRight(network.endpoint("probe")),
      Effect.exit,
      Effect.fork,
    );
    yield* Deferred.await(waiterStarted);
    yield* Effect.yieldNow();

    yield* Deferred.succeed(gates.releaseFirst, undefined);
    yield* Deferred.await(gates.retryStarted);
    const failed = yield* Fiber.join(lateWaiter);
    const peer = yield* network.endpoint("probe").pipe(Effect.fork);
    yield* Effect.yieldNow();
    assert.isTrue(Exit.isFailure(failed));
    assert.strictEqual(attempts.value, 2);

    yield* Deferred.succeed(gates.releaseRetry, undefined);
    const retry = yield* Fiber.join(retrying);
    const coalesced = yield* Fiber.join(peer);
    assert.strictEqual(retry, coalesced);
    assert.strictEqual(attempts.value, 2);
    assert.strictEqual(attachments.value, 1);
  });
}

test("evicts a failed attachment without letting late waiters evict its retry", () =>
  Effect.scoped(failedAttachmentRetryTest()));

interface AttachmentLifecycle {
  attempts: number;
  live: number;
  releases: number;
}

function interruptibleRouter(
  baseRouter: Router,
  lifecycle: AttachmentLifecycle,
  firstStarted: Deferred.Deferred<undefined>,
): Router {
  return {
    ...baseRouter,
    attachEndpoint: (name, agentName) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          lifecycle.attempts += 1;
          lifecycle.live += 1;
          return lifecycle.attempts;
        }),
        () =>
          Effect.sync(() => {
            lifecycle.live -= 1;
            lifecycle.releases += 1;
          }),
      ).pipe(
        Effect.flatMap((attempt) =>
          attempt === 1
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.zipRight(Effect.never),
              )
            : baseRouter.attachEndpoint(name, agentName),
        ),
      ),
  };
}

function canceledAttachmentTest(lifecycle: AttachmentLifecycle) {
  return Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<undefined>();
    const attachments = { value: 0 };
    const baseRouter = router(Stream.never, attachments);
    const network = yield* makeNetworkService(
      interruptibleRouter(baseRouter, lifecycle, firstStarted),
      writer([]),
    );
    const first = yield* network.endpoint("probe").pipe(Effect.fork);
    yield* Deferred.await(firstStarted);
    yield* Fiber.interrupt(first);

    assert.strictEqual(lifecycle.live, 0);
    assert.strictEqual(lifecycle.releases, 1);

    yield* network.endpoint("probe");
    assert.strictEqual(lifecycle.attempts, 2);
    assert.strictEqual(lifecycle.live, 1);
    assert.strictEqual(attachments.value, 1);
  });
}

test("releases a canceled attachment attempt before retrying", () =>
  Effect.gen(function* () {
    const lifecycle: AttachmentLifecycle = {
      attempts: 0,
      live: 0,
      releases: 0,
    };
    yield* Effect.scoped(canceledAttachmentTest(lifecycle));
    assert.strictEqual(lifecycle.live, 0);
    assert.strictEqual(lifecycle.releases, 2);
  }));

function deliveryBeforeBindingTest() {
  return Effect.gen(function* () {
    const processed = yield* Deferred.make<undefined>();
    const allowSecond = yield* Deferred.make<undefined>();
    const firstDelivery = receivedMessage(RECEIVED_ID, "early");
    const received = Stream.make(firstDelivery).pipe(
      Stream.concat(
        Stream.fromEffect(Deferred.succeed(processed, undefined)).pipe(
          Stream.drain,
        ),
      ),
      Stream.concat(
        Stream.fromEffect(
          Deferred.await(allowSecond).pipe(
            Effect.as(receivedMessage(SECOND_RECEIVED_ID, "live")),
          ),
        ),
      ),
      Stream.concat(Stream.never),
    );
    const events: EndpointEvent[] = [];
    const network = yield* makeNetworkService(
      router(received, { value: 0 }),
      writer(events),
    );
    const probe = yield* network.endpoint("probe");
    yield* Deferred.await(processed);

    const socket = yield* probe.open(
      makeParticipantHandle("target", TARGET_ID),
    );
    const early = yield* socket.receive();
    const liveFiber = yield* probe
      .messages()
      .pipe(Stream.take(1), Stream.runHead, Effect.fork);
    yield* Effect.yieldNow();
    yield* Deferred.succeed(allowSecond, undefined);
    const live = yield* Fiber.join(liveFiber);
    const next = yield* socket.receive();

    assert.strictEqual(early.message.id, RECEIVED_ID);
    assert.strictEqual(Option.getOrThrow(live).message.id, SECOND_RECEIVED_ID);
    assert.strictEqual(next.message.id, SECOND_RECEIVED_ID);
  });
}

test("backlogs conversations without replaying history to live endpoint observers", () =>
  Effect.scoped(deliveryBeforeBindingTest()));

function unavailableWriter(
  attempted?: Deferred.Deferred<undefined>,
): EndpointEventWriter {
  return {
    write: () =>
      (attempted === undefined
        ? Effect.void
        : Deferred.succeed(attempted, undefined).pipe(Effect.asVoid)
      ).pipe(
        Effect.zipRight(
          Effect.fail(
            LedgerStorageError.make({
              operation: "append",
              detail: "ledger unavailable",
            }),
          ),
        ),
      ),
  };
}

test("returns a committed send without fabricating a retryable network failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sends = { value: 0 };
      const network = yield* makeNetworkService(
        router(Stream.never, { value: 0 }, sends),
        unavailableWriter(),
      );
      const probe = yield* network.endpoint("probe");
      const socket = yield* probe.open(
        makeParticipantHandle("target", TARGET_ID),
      );
      const sent = yield* Effect.exit(socket.send("request"));

      assert.isTrue(Exit.isSuccess(sent));
      assert.strictEqual(sends.value, 1);
    }),
  ));

test("does not deliver ingress whose ledger evidence failed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const deliveries = yield* PubSub.unbounded<ReceivedMessage>();
      const received = yield* Stream.fromPubSub(deliveries, {
        scoped: true,
      });
      const attempted = yield* Deferred.make<undefined>();
      const network = yield* makeNetworkService(
        router(received, { value: 0 }),
        unavailableWriter(attempted),
      );
      const probe = yield* network.endpoint("probe");
      const delivery = yield* probe
        .messages()
        .pipe(Stream.runHead, Effect.fork);

      yield* PubSub.publish(
        deliveries,
        receivedMessage(RECEIVED_ID, "unevidenced"),
      );
      yield* Deferred.await(attempted);
      yield* Effect.yieldNow();

      assert.isTrue(Option.isNone(yield* Fiber.poll(delivery)));
      yield* Fiber.interrupt(delivery);
    }),
  ));
