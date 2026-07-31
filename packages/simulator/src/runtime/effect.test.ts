import { assert, beforeEach, expect, it } from "@effect/vitest";
import {
  messageReceivedNotificationDefinition,
  messagesSend,
  type MessageReceivedNotification,
} from "@moltzap/protocol/message";
import { httpBaseUrl, serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentName,
  agentKeyString,
  conversationId,
  messageId,
  redactedAgentKey,
  taskId,
} from "@moltzap/protocol/testing";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Schema,
  Stream,
} from "effect";
import { vi } from "vitest";
import { type AgentConnection, makeAgentHandle } from "../network.js";
import {
  EffectRuntimeStartFailed,
  effectRuntime,
  type EffectRuntimeContext,
} from "./effect.js";
import { RuntimeCompleted, RuntimeFailed } from "./runtime.js";

interface FakeClientState {
  received?: Stream.Stream<MessageReceivedNotification, unknown>;
  readonly constructed: Array<{
    readonly serverUrl: string;
    readonly agentKey: unknown;
  }>;
  readonly events: string[];
  readonly sent: Array<{
    readonly definition: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }>;
  connects: number;
  closes: number;
}

const clientState = vi.hoisted(
  (): FakeClientState => ({
    received: undefined,
    constructed: [],
    events: [],
    sent: [],
    connects: 0,
    closes: 0,
  }),
);

vi.mock("@moltzap/client", () => ({
  MoltZapAgentClient: class {
    constructor(options: {
      readonly serverUrl: string;
      readonly agentKey: unknown;
    }) {
      clientState.constructed.push(options);
    }

    connect() {
      return Effect.sync(() => {
        clientState.events.push("connect");
        clientState.connects += 1;
      });
    }

    close() {
      return Effect.sync(() => {
        clientState.events.push("close");
        clientState.closes += 1;
      });
    }

    subscribeScoped(definition: { readonly name: string }) {
      clientState.events.push(`subscribe:${definition.name}`);
      return clientState.received === undefined
        ? Effect.dieMessage("test did not install a receive stream")
        : Effect.succeed(clientState.received);
    }

    callDefinition(
      definition: { readonly name: string },
      payload: Readonly<Record<string, unknown>>,
    ) {
      return Effect.sync(() => {
        clientState.sent.push({
          definition: definition.name,
          payload,
        });
        return {};
      });
    }
  },
}));

const AGENT_ID = agentId("11111111-1111-4111-8111-111111111111");
const SENDER_ID = agentId("22222222-2222-4222-8222-222222222222");
const AGENT_KEY = redactedAgentKey(agentKeyString(80));
const ROUTER_URL = serverBaseUrl("ws://127.0.0.1:3000");
const STARTUP_TIMEOUT = Duration.seconds(3);
const EXPECTED_RUNTIME_NAME = "effect";
const ROSTER_KEY = "alice";
const AGENT_NAME = agentName(ROSTER_KEY);
const ORIGINAL_VERSION = "original";
const REPLACEMENT_VERSION = "replacement";
const INCOMING: MessageReceivedNotification = {
  taskId: taskId("33333333-3333-4333-8333-333333333333"),
  message: {
    id: messageId("44444444-4444-4444-8444-444444444444"),
    conversationId: conversationId("55555555-5555-4555-8555-555555555555"),
    senderId: SENDER_ID,
    parts: [{ type: "text", text: "ping" }],
    createdAt: "2026-07-28T00:00:00.000Z",
  },
};

beforeEach(() => {
  clientState.received = undefined;
  clientState.constructed.length = 0;
  clientState.events.length = 0;
  clientState.sent.length = 0;
  clientState.connects = 0;
  clientState.closes = 0;
});

function connection(
  observeReady: (within: Duration.Duration) => void,
): AgentConnection<"alice"> {
  return {
    agent: makeAgentHandle(ROSTER_KEY, AGENT_ID),
    key: AGENT_KEY,
    routerUrl: ROUTER_URL,
    awaitReady: (within) =>
      Effect.sync(() => {
        observeReady(within);
      }),
  };
}

interface ReceivedDelivery {
  readonly context: EffectRuntimeContext;
  readonly notification: MessageReceivedNotification;
}

function makeGatewayRuntime(received: Deferred.Deferred<ReceivedDelivery>) {
  return effectRuntime({
    startupTimeout: STARTUP_TIMEOUT,
    build: (context) =>
      Effect.sync(() => {
        clientState.events.push("build");
        return {
          gateway: {
            send: (text: string) =>
              context.client
                .callDefinition(messagesSend, {
                  taskId: INCOMING.taskId,
                  conversationId: INCOMING.message.conversationId,
                  parts: [{ type: "text", text }],
                })
                .pipe(Effect.asVoid),
          },
          behavior: context.messages.pipe(
            Stream.runForEach((notification) =>
              Deferred.succeed(received, {
                context,
                notification,
              }).pipe(Effect.asVoid),
            ),
          ),
        };
      }),
  });
}

function assertStartupOrder(): void {
  assert.strictEqual(
    clientState.events[0],
    `subscribe:${messageReceivedNotificationDefinition.name}`,
  );
  assert.isBelow(
    clientState.events.indexOf("connect"),
    clientState.events.indexOf("build"),
  );
  assert.isBelow(
    clientState.events.indexOf("ready"),
    clientState.events.indexOf("build"),
  );
}

it("publishes definition-time policy without exposing customer code", () => {
  const runtime = effectRuntime({
    startupTimeout: STARTUP_TIMEOUT,
    build: () =>
      Effect.succeed({
        gateway: {},
        behavior: Effect.never,
      }),
  });
  const encoded = Schema.encodeSync(runtime.configuration.schema)(
    runtime.configuration.value,
  );

  expect(encoded).toStrictEqual({
    startupTimeout: Duration.toMillis(STARTUP_TIMEOUT),
  });
});

// @agent-code-guard/regression-only: controlled client lifecycles expose protocol routing, termination, and scope cleanup order directly
it.effect(
  "exposes a typed gateway, identity, and eagerly registered message stream",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delivery = yield* Deferred.make<MessageReceivedNotification>();
        const received = yield* Deferred.make<ReceivedDelivery>();
        let readyWithin: Duration.Duration | undefined;
        clientState.received = Stream.fromEffect(Deferred.await(delivery));
        const runtime = makeGatewayRuntime(received);

        const running = yield* runtime.acquire({
          agentName: AGENT_NAME,
          connection: connection((within) => {
            clientState.events.push("ready");
            readyWithin = within;
          }),
        });
        yield* running.gateway.send("outbound");
        yield* Deferred.succeed(delivery, INCOMING);
        const observed = yield* Deferred.await(received);
        const termination = yield* running.termination;

        assert.instanceOf(termination, RuntimeCompleted);
        assert.strictEqual(observed.context.agent.id, AGENT_ID);
        assert.strictEqual(observed.context.agent.name, AGENT_NAME);
        assert.deepStrictEqual(observed.notification, INCOMING);
        assert.strictEqual(clientState.connects, 1);
        assert.deepStrictEqual(readyWithin, STARTUP_TIMEOUT);
        assert.strictEqual(
          clientState.constructed[0]?.serverUrl,
          httpBaseUrl(ROUTER_URL),
        );
        assertStartupOrder();
        assert.strictEqual(clientState.sent[0]?.definition, messagesSend.name);
        assert.deepEqual(clientState.sent[0]?.payload, {
          taskId: INCOMING.taskId,
          conversationId: INCOMING.message.conversationId,
          parts: [{ type: "text", text: "outbound" }],
        });
      }),
    ),
);

it.effect("turns behavior failure into a runtime observation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      clientState.received = Stream.never;
      const runtime = effectRuntime({
        build: () =>
          Effect.succeed({
            gateway: {},
            behavior: Effect.fail("behavior failed"),
          }),
      });
      const running = yield* runtime.acquire({
        agentName: AGENT_NAME,
        connection: connection(() => undefined),
      });

      const termination = yield* running.termination;

      assert.instanceOf(termination, RuntimeFailed);
      assert.include(termination.detail, "behavior failed");
      assert.isAtLeast(clientState.closes, 1);
      assert.lengthOf(clientState.sent, 0);
    }),
  ),
);

it.effect("reports autonomous interruption as runtime failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      clientState.received = Stream.never;
      const runtime = effectRuntime({
        build: () =>
          Effect.succeed({
            gateway: {},
            behavior: Effect.interrupt,
          }),
      });
      const running = yield* runtime.acquire({
        agentName: AGENT_NAME,
        connection: connection(() => undefined),
      });

      const termination = yield* running.termination;

      assert.instanceOf(termination, RuntimeFailed);
      assert.include(termination.detail, "interrupted");
    }),
  ),
);

it.effect("maps builder failure to acquisition failure", () =>
  Effect.gen(function* () {
    clientState.received = Stream.never;
    const runtime = effectRuntime({
      build: () => Effect.fail("builder failed"),
    });

    const failure = yield* Effect.scoped(
      runtime
        .acquire({
          agentName: AGENT_NAME,
          connection: connection(() => undefined),
        })
        .pipe(Effect.flip),
    );

    assert.instanceOf(failure, EffectRuntimeStartFailed);
    assert.include(failure.detail, "builder failed");
    assert.strictEqual(clientState.closes, 1);
  }),
);

it.effect("scope teardown closes the client without reporting completion", () =>
  Effect.gen(function* () {
    clientState.received = Stream.never;

    const running = yield* Effect.scoped(
      effectRuntime({
        build: () =>
          Effect.succeed({
            gateway: {},
            behavior: Effect.never,
          }),
      }).acquire({
        agentName: AGENT_NAME,
        connection: connection(() => undefined),
      }),
    );
    const termination = yield* Effect.fork(running.termination);
    yield* Effect.yieldNow();
    const observed = yield* Fiber.poll(termination);
    yield* Fiber.interrupt(termination);

    assert.strictEqual(clientState.closes, 1);
    assert.isTrue(Option.isNone(observed));
  }),
);

it.effect("snapshots the builder at runtime construction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      clientState.received = Stream.never;
      const options = {
        build: () =>
          Effect.succeed({
            gateway: { version: ORIGINAL_VERSION },
            behavior: Effect.never,
          }),
      };
      const runtime = effectRuntime(options);
      options.build = () =>
        Effect.succeed({
          gateway: { version: REPLACEMENT_VERSION },
          behavior: Effect.never,
        });

      const running = yield* runtime.acquire({
        agentName: AGENT_NAME,
        connection: connection(() => undefined),
      });

      assert.strictEqual(running.gateway.version, ORIGINAL_VERSION);
    }),
  ),
);

it("identifies the runtime implementation", () => {
  expect(
    effectRuntime({
      build: () =>
        Effect.succeed({
          gateway: {},
          behavior: Effect.never,
        }),
    }).name,
  ).toBe(EXPECTED_RUNTIME_NAME);
});
