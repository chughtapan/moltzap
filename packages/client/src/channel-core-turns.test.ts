/**
 * Turn-taking behavior of `MoltZapChannelCore`: one turn at a time, arrival
 * order across conversations, same-conversation coalescing, and the optional
 * per-turn timeout. Turn-taking is entirely endpoint-local — the server
 * delivers every message it accepts.
 */

import { expect, it, vi } from "vitest";
import { Effect } from "effect";

import {
  FIRST_TEXT,
  SECOND_TEXT,
  buildMessage,
  conversation,
  createFakeChannelService,
  customSetup,
  effectTest,
  flushDispatchChainEffect,
  message,
  MoltZapChannelCore,
  type EnrichedInboundMessage,
  type FakeChannelService,
} from "./channel-core-test-support.js";

const CONV_1 = "conv-1";
const CONV_2 = "conv-2";
const THIRD_TEXT = "third";
const OTHER_CONVERSATION_TEXT = "elsewhere";
const STUCK_TURN_TIMEOUT_MS = 20;
const TIMEOUT_TEST_SETTLE_MS = 80;

interface TurnGate {
  readonly started: string[];
  readonly release: () => void;
}

interface GatedHandler {
  readonly gate: TurnGate;
  readonly handle: (msg: EnrichedInboundMessage) => Effect.Effect<void>;
}

function awaitRelease(pending: Array<() => void>): Effect.Effect<void> {
  return Effect.async<undefined>((resume) => {
    pending.push(() => {
      resume(Effect.succeed(undefined));
    });
  }).pipe(Effect.asVoid);
}

/**
 * Handler that records each turn it enters and blocks until released, so a
 * later message can be observed queueing behind the running turn.
 * @param received Sink for every message the gate admits.
 * @returns The gate controlling turn completion.
 */
function gatedHandler(received: EnrichedInboundMessage[]): GatedHandler {
  const started: string[] = [];
  const pending: Array<() => void> = [];
  const handle = (msg: EnrichedInboundMessage): Effect.Effect<void> =>
    Effect.suspend(() => {
      started.push(msg.id);
      received.push(msg);
      return awaitRelease(pending);
    });
  return {
    gate: {
      started,
      release: () => {
        pending.shift()?.();
      },
    },
    handle,
  };
}

function emitText(
  fake: FakeChannelService,
  spec: { readonly id: string; readonly conversationId: string },
  text: string,
): void {
  fake.emit.message(
    buildMessage({
      id: spec.id,
      conversationId: spec.conversationId,
      parts: [{ type: "text", text }],
    }),
  );
}

function setDmConversation(fake: FakeChannelService, convId: string): void {
  fake.state.setConversation(convId, { type: "dm", participants: [] });
  fake.state.setAgentName("agent-alice", "Alice");
}

function runsOneTurnAtATime() {
  return Effect.gen(function* () {
    const { fake, core } = customSetup();
    setDmConversation(fake, CONV_1);
    const received: EnrichedInboundMessage[] = [];
    const { gate, handle } = gatedHandler(received);
    core.onInbound(handle);

    emitText(fake, { id: "msg-1", conversationId: CONV_1 }, FIRST_TEXT);
    yield* flushDispatchChainEffect;
    expect(gate.started).toEqual([message("msg-1")]);

    emitText(fake, { id: "msg-2", conversationId: CONV_2 }, SECOND_TEXT);
    yield* flushDispatchChainEffect;
    // The second message waits: the first turn owns the consumer fiber.
    expect(gate.started).toEqual([message("msg-1")]);

    gate.release();
    yield* flushDispatchChainEffect;
    expect(gate.started).toEqual([message("msg-1"), message("msg-2")]);
  });
}

effectTest("runs one turn at a time", runsOneTurnAtATime);

function coalescesSameConversationBacklogIntoOneTurn() {
  return Effect.gen(function* () {
    const { fake, core } = customSetup();
    setDmConversation(fake, CONV_1);
    const received: EnrichedInboundMessage[] = [];
    const { gate, handle } = gatedHandler(received);
    core.onInbound(handle);

    emitText(fake, { id: "msg-1", conversationId: CONV_1 }, FIRST_TEXT);
    yield* flushDispatchChainEffect;

    emitText(fake, { id: "msg-2", conversationId: CONV_1 }, SECOND_TEXT);
    emitText(fake, { id: "msg-3", conversationId: CONV_1 }, THIRD_TEXT);
    gate.release();
    yield* flushDispatchChainEffect;

    expect(gate.started).toEqual([message("msg-1"), message("msg-2")]);
    const second =
      /* Safe because the test fixture establishes this asserted shape. */ received[1]!;
    expect(second.text).toContain(SECOND_TEXT);
    expect(second.text).toContain(THIRD_TEXT);
    expect(second.coalescedMessages?.map((entry) => entry.id)).toEqual([
      message("msg-2"),
      message("msg-3"),
    ]);
  });
}

effectTest(
  "coalesces same-conversation backlog into one turn",
  coalescesSameConversationBacklogIntoOneTurn,
);

function keepsOtherConversationsInArrivalOrder() {
  return Effect.gen(function* () {
    const { fake, core } = customSetup();
    setDmConversation(fake, CONV_1);
    setDmConversation(fake, CONV_2);
    const received: EnrichedInboundMessage[] = [];
    const { gate, handle } = gatedHandler(received);
    core.onInbound(handle);

    emitText(fake, { id: "msg-1", conversationId: CONV_1 }, FIRST_TEXT);
    yield* flushDispatchChainEffect;

    emitText(
      fake,
      { id: "msg-other", conversationId: CONV_2 },
      OTHER_CONVERSATION_TEXT,
    );
    emitText(fake, { id: "msg-2", conversationId: CONV_1 }, SECOND_TEXT);

    gate.release();
    yield* flushDispatchChainEffect;
    gate.release();
    yield* flushDispatchChainEffect;

    // Coalescing pulls only the running turn's conversation forward, so the
    // earlier-arriving other conversation still takes the next turn.
    expect(gate.started).toEqual([
      message("msg-1"),
      message("msg-other"),
      message("msg-2"),
    ]);
    expect(received.map((entry) => entry.conversationId)).toEqual([
      conversation(CONV_1),
      conversation(CONV_2),
      conversation(CONV_1),
    ]);
  });
}

effectTest(
  "keeps other conversations in arrival order",
  keepsOtherConversationsInArrivalOrder,
);

function recordUnlessStuck(
  completed: string[],
): (msg: EnrichedInboundMessage) => Effect.Effect<void> {
  return (msg) =>
    msg.id === message("msg-stuck")
      ? Effect.never
      : Effect.sync(() => {
          completed.push(msg.id);
        });
}

function abandonsHungTurn() {
  return Effect.gen(function* () {
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    setDmConversation(fake, CONV_1);
    const core = new MoltZapChannelCore({
      service: fake.service,
      turnTimeoutMs: STUCK_TURN_TIMEOUT_MS,
    });
    const completed: string[] = [];
    core.onInbound(recordUnlessStuck(completed));

    emitText(fake, { id: "msg-stuck", conversationId: CONV_1 }, FIRST_TEXT);
    yield* flushDispatchChainEffect;
    emitText(fake, { id: "msg-next", conversationId: CONV_2 }, SECOND_TEXT);
    yield* Effect.sleep(TIMEOUT_TEST_SETTLE_MS);
    yield* flushDispatchChainEffect;

    expect(completed).toEqual([message("msg-next")]);
  });
}

it("abandons a hung turn after turnTimeoutMs and runs the next one", () =>
  Effect.runPromise(abandonsHungTurn()));

function onInboundReplacesThePreviousHandler() {
  return Effect.gen(function* () {
    const { fake, core } = customSetup();
    setDmConversation(fake, CONV_1);

    const firstHandler = vi.fn<(msg: EnrichedInboundMessage) => void>();
    const secondHandler = vi.fn<(msg: EnrichedInboundMessage) => void>();
    core.onInbound((msg) =>
      Effect.sync(() => {
        firstHandler(msg);
      }),
    );
    core.onInbound((msg) =>
      Effect.sync(() => {
        secondHandler(msg);
      }),
    );

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledOnce();
  });
}

effectTest(
  "onInbound replaces the previous handler instead of adding",
  onInboundReplacesThePreviousHandler,
);
