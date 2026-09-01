/** @file Public-boundary tests for NanoClaw's addressed MoltZap adapter. */

import { live as it } from "@effect/vitest";
import {
  DeliveryAcknowledgeError,
  type HarnessEndpoint,
  type InboundDelivery,
  ListenError,
  InboundMessage as MoltZapInboundMessage,
  type SendInput,
} from "@moltzap/client";
import { Deferred, Effect, Option, Queue, Schema, Stream } from "effect";
import { describe, expect, vi, it as vitestIt } from "vitest";

import type { ChannelSetup } from "./adapter.js";
import { makeMoltZapAdapter, MoltZapAdapter } from "./moltzap.js";

interface FakeEndpoint {
  readonly endpoint: HarnessEndpoint;
  readonly queue: Queue.Queue<InboundDelivery>;
  readonly sends: SendInput[];
}

const DIRECT_ADDRESS = "agent:alice";
const GROUP_ADDRESS = "group:alice,bob,local";
const DIRECT_POST_ID = `pst_${"A".repeat(43)}`;
const GROUP_POST_ID = "pst_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const GROUP_MEMBERS = ["agent:alice", "agent:bob", "agent:local"] as const;
const GROUP_INBOUND_CONTENT = {
  text: 'status\n{"ready":true}',
  address: GROUP_ADDRESS,
  sender: "agent:bob",
  senderId: "agent:bob",
  members: GROUP_MEMBERS,
} as const;

const directMessage = Schema.decodeUnknownSync(MoltZapInboundMessage)({
  kind: "direct",
  postId: DIRECT_POST_ID,
  address: DIRECT_ADDRESS,
  sender: DIRECT_ADDRESS,
  content: [{ type: "text", text: "hello" }],
});

const groupMessage = Schema.decodeUnknownSync(MoltZapInboundMessage)({
  kind: "group",
  postId: GROUP_POST_ID,
  address: GROUP_ADDRESS,
  sender: "agent:bob",
  members: GROUP_MEMBERS,
  content: [
    { type: "text", text: "status" },
    { type: "data", value: { ready: true } },
  ],
});

function createFakeEndpoint(): Effect.Effect<FakeEndpoint> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<InboundDelivery>();
    const sends: SendInput[] = [];
    return {
      queue,
      sends,
      endpoint: {
        send: (input) =>
          Effect.sync(() => {
            sends.push(input);
          }),
        messages: Stream.fromQueue(queue),
      },
    };
  });
}

function hostSetup(overrides: Partial<ChannelSetup> = {}): ChannelSetup {
  return {
    onInbound: () => Promise.resolve(),
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
    ...overrides,
  };
}

function setupAdapter(
  adapter: MoltZapAdapter,
  setup: ChannelSetup,
): Effect.Effect<void, unknown> {
  return runPromise(() => adapter.setup(setup));
}

function teardownAdapter(
  adapter: MoltZapAdapter,
): Effect.Effect<void, unknown> {
  return runPromise(() => adapter.teardown());
}

function waitForDisconnected(adapter: MoltZapAdapter): Effect.Effect<void> {
  return runPromise(() =>
    vi.waitFor(() => {
      expect(adapter.isConnected()).toBe(false);
    }),
  ).pipe(Effect.orDie);
}

function runPromise<A>(
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, unknown> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => cause,
  });
}

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The delivery laws share one endpoint fixture and lifecycle.
describe("MoltZapAdapter delivery", () => {
  it("acknowledges only after NanoClaw's stock inbound callback completes", () =>
    Effect.gen(function* () {
      const fake = yield* createFakeEndpoint();
      const inboundStarted = yield* Deferred.make<undefined>();
      const allowCallback = yield* Deferred.make<undefined>();
      const acknowledged = yield* Deferred.make<undefined>();
      const events: string[] = [];
      const adapter = MoltZapAdapter.fromEndpoint(fake.endpoint);
      yield* setupAdapter(
        adapter,
        hostSetup({
          onInbound: () => {
            events.push("inbound");
            Effect.runSync(Deferred.succeed(inboundStarted, undefined));
            return Effect.runPromise(Deferred.await(allowCallback));
          },
        }),
      );

      yield* Queue.offer(fake.queue, {
        message: directMessage,
        acknowledge: Effect.sync(() => {
          events.push("acknowledge");
          Effect.runSync(Deferred.succeed(acknowledged, undefined));
        }),
      });
      yield* Deferred.await(inboundStarted);
      expect(Option.isNone(yield* Deferred.poll(acknowledged))).toBe(true);

      yield* Deferred.succeed(allowCallback, undefined);
      yield* Deferred.await(acknowledged);
      expect(events).toEqual(["inbound", "acknowledge"]);
      yield* teardownAdapter(adapter);
    }));

  it("keeps host, acknowledge, and transport failures stream-fatal", () =>
    Effect.gen(function* () {
      const hostFailure = yield* createFakeEndpoint();
      const hostAdapter = MoltZapAdapter.fromEndpoint(hostFailure.endpoint);
      yield* setupAdapter(
        hostAdapter,
        hostSetup({
          onInbound: () => Promise.reject(new Error("host collision")),
        }),
      );
      yield* Queue.offer(hostFailure.queue, {
        message: directMessage,
        acknowledge: Effect.void,
      });
      yield* waitForDisconnected(hostAdapter);

      const acknowledgeFailure = yield* createFakeEndpoint();
      const acknowledgeAdapter = MoltZapAdapter.fromEndpoint(
        acknowledgeFailure.endpoint,
      );
      yield* setupAdapter(
        acknowledgeAdapter,
        hostSetup({ onInbound: () => {} }),
      );
      yield* Queue.offer(acknowledgeFailure.queue, {
        message: directMessage,
        acknowledge: Effect.fail(
          new DeliveryAcknowledgeError({ reason: "transport-failed" }),
        ),
      });
      yield* waitForDisconnected(acknowledgeAdapter);

      const transportAdapter = MoltZapAdapter.fromEndpoint({
        send: () => Effect.void,
        messages: Stream.fail(new ListenError({ reason: "transport-failed" })),
      });
      yield* setupAdapter(transportAdapter, hostSetup());
      yield* waitForDisconnected(transportAdapter);
    }));

  it("forwards each native delivery call once to Client", () =>
    Effect.gen(function* () {
      const fake = yield* createFakeEndpoint();
      const adapter = MoltZapAdapter.fromEndpoint(fake.endpoint);
      yield* setupAdapter(adapter, hostSetup());
      yield* runPromise(() =>
        adapter.deliver("group:bob,alice", null, {
          kind: "chat",
          content: { text: "ready" },
        }),
      );
      yield* runPromise(() =>
        adapter.deliver(GROUP_ADDRESS, null, {
          kind: "chat",
          content: { text: "ready" },
        }),
      );
      expect(fake.sends).toHaveLength(2);
      expect(fake.sends).toEqual([
        {
          to: "group:bob,alice",
          content: [{ type: "text", text: "ready" }],
        },
        {
          to: GROUP_ADDRESS,
          content: [{ type: "text", text: "ready" }],
        },
      ]);
      yield* teardownAdapter(adapter);
    }));
});

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- Address projection and reconnect behavior share one adapter fixture.
describe("MoltZapAdapter canonical addresses", () => {
  it("projects exact group identity and membership", () =>
    Effect.gen(function* () {
      const fake = yield* createFakeEndpoint();
      const acknowledged = yield* Deferred.make<undefined>();
      const received: Array<Parameters<ChannelSetup["onInbound"]>> = [];
      const metadata: Array<{
        address: string;
        name?: string;
        isGroup?: boolean;
      }> = [];
      const adapter = MoltZapAdapter.fromEndpoint(fake.endpoint);
      yield* setupAdapter(
        adapter,
        hostSetup({
          onMetadata: (address, name, isGroup) => {
            metadata.push({ address, name, isGroup });
          },
          onInbound: (...input) => {
            received.push(input);
            return Promise.resolve();
          },
        }),
      );
      yield* Queue.offer(fake.queue, {
        message: groupMessage,
        acknowledge: Deferred.succeed(acknowledged, undefined),
      });
      yield* Deferred.await(acknowledged);

      expect(metadata).toEqual([
        { address: GROUP_ADDRESS, name: GROUP_ADDRESS, isGroup: true },
      ]);
      expect(received).toEqual([
        [
          GROUP_ADDRESS,
          null,
          {
            id: GROUP_POST_ID,
            kind: "chat",
            timestamp: "1970-01-01T00:00:00.000Z",
            isMention: true,
            isGroup: true,
            content: GROUP_INBOUND_CONTENT,
          },
        ],
      ]);
      yield* teardownAdapter(adapter);
    }));

  it("reacquires after a failed stream and tears down the new activation", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<InboundDelivery>();
      let subscriptions = 0;
      const endpoint: HarnessEndpoint = {
        send: () => Effect.void,
        messages: Stream.unwrap(
          Effect.sync(() => {
            subscriptions += 1;
            return subscriptions === 1
              ? Stream.fail(new ListenError({ reason: "transport-failed" }))
              : Stream.fromQueue(queue);
          }),
        ),
      };
      const adapter = MoltZapAdapter.fromEndpoint(endpoint);

      yield* setupAdapter(adapter, hostSetup());
      yield* waitForDisconnected(adapter);
      yield* setupAdapter(adapter, hostSetup());
      yield* runPromise(() =>
        vi.waitFor(() => {
          expect(subscriptions).toBe(2);
        }),
      );
      expect(adapter.isConnected()).toBe(true);

      yield* teardownAdapter(adapter);
      expect(adapter.isConnected()).toBe(false);
    }));
});

describe("MoltZapAdapter configuration", () => {
  vitestIt("creates an MCP-backed adapter from a loopback URL", () => {
    expect(
      makeMoltZapAdapter({ mcpEndpoint: "http://127.0.0.1:4100/mcp" }),
    ).toBeInstanceOf(MoltZapAdapter);
  });
});
