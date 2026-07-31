import { assert, beforeEach, expect, it } from "@effect/vitest";
import { type AgentConnection, makeAgentHandle } from "../network.js";
import { RuntimeCompleted, RuntimeFailed } from "./runtime.js";
import {
  messagesSend,
  type MessageReceivedNotification,
} from "@moltzap/protocol/message";
import { httpBaseUrl, serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentKeyString,
  conversationId,
  messageId,
  redactedAgentKey,
  taskId,
} from "@moltzap/protocol/testing";
import { Deferred, Duration, Effect, Fiber, Option, Stream } from "effect";
import { vi } from "vitest";
import { effectRuntime, type EffectMessageContext } from "./effect.js";

interface FakeClientState {
  received?: Stream.Stream<MessageReceivedNotification, unknown>;
  readonly constructed: Array<{
    readonly serverUrl: string;
    readonly agentKey: unknown;
  }>;
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
        clientState.connects += 1;
      });
    }

    close() {
      return Effect.sync(() => {
        clientState.closes += 1;
      });
    }

    subscribeScoped() {
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
  clientState.sent.length = 0;
  clientState.connects = 0;
  clientState.closes = 0;
});

function connection(
  observeReady: (within: Duration.Duration) => void,
): AgentConnection<"alice"> {
  return {
    agent: makeAgentHandle("alice", AGENT_ID),
    key: AGENT_KEY,
    routerUrl: ROUTER_URL,
    awaitReady: (within) =>
      Effect.sync(() => {
        observeReady(within);
      }),
  };
}

// @agent-code-guard/regression-only: controlled client lifecycles expose protocol routing, termination, and scope cleanup order directly
it.effect("uses the wire protocol for readiness, delivery, and replies", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delivery = yield* Deferred.make<MessageReceivedNotification>();
      const callback = yield* Deferred.make<EffectMessageContext>();
      let readyWithin: Duration.Duration | undefined;
      clientState.received = Stream.fromEffect(Deferred.await(delivery));
      const runtime = effectRuntime({
        startupTimeout: STARTUP_TIMEOUT,
        onMessage: (context) =>
          Deferred.succeed(callback, context).pipe(Effect.as("pong")),
      });

      const running = yield* runtime.acquire({
        connection: connection((within) => {
          readyWithin = within;
        }),
      });
      yield* Deferred.succeed(delivery, INCOMING);
      const observed = yield* Deferred.await(callback);
      const termination = yield* running.termination;

      assert.instanceOf(termination, RuntimeCompleted);
      assert.strictEqual(observed.agent.id, AGENT_ID);
      assert.strictEqual(clientState.connects, 1);
      assert.deepStrictEqual(readyWithin, STARTUP_TIMEOUT);
      assert.strictEqual(
        clientState.constructed[0]?.serverUrl,
        httpBaseUrl(ROUTER_URL),
      );
      assert.strictEqual(clientState.sent[0]?.definition, messagesSend.name);
      assert.deepInclude(clientState.sent[0]?.payload, {
        taskId: INCOMING.taskId,
        conversationId: INCOMING.message.conversationId,
        parts: [{ type: "text", text: "pong" }],
      });
    }),
  ),
);

it.effect("turns callback failure into a runtime observation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delivery = yield* Deferred.make<MessageReceivedNotification>();
      clientState.received = Stream.fromEffect(Deferred.await(delivery));
      const runtime = effectRuntime({
        onMessage: () => Effect.fail("handler failed"),
      });
      const running = yield* runtime.acquire({
        connection: connection(() => undefined),
      });

      yield* Deferred.succeed(delivery, INCOMING);
      const termination = yield* running.termination;

      assert.instanceOf(termination, RuntimeFailed);
      assert.include(termination.detail, "handler failed");
      assert.isAtLeast(clientState.closes, 1);
      assert.lengthOf(clientState.sent, 0);
    }),
  ),
);

it.effect("scope teardown closes the client without reporting completion", () =>
  Effect.gen(function* () {
    clientState.received = Stream.never;

    const running = yield* Effect.scoped(
      effectRuntime().acquire({
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

it.effect("snapshots runtime options at construction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delivery = yield* Deferred.make<MessageReceivedNotification>();
      clientState.received = Stream.fromEffect(Deferred.await(delivery));
      const options = {
        onMessage: () => Effect.succeed("original"),
      };
      const runtime = effectRuntime(options);
      options.onMessage = () => Effect.succeed("replacement");

      const running = yield* runtime.acquire({
        connection: connection(() => undefined),
      });
      yield* Deferred.succeed(delivery, INCOMING);
      yield* running.termination;

      assert.deepInclude(clientState.sent[0]?.payload, {
        parts: [{ type: "text", text: "original" }],
      });
    }),
  ),
);

it("identifies the runtime implementation", () => {
  expect(effectRuntime().name).toBe(EXPECTED_RUNTIME_NAME);
});
