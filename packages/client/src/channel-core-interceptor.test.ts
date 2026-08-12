/**
 * @file Exercises endpoint-side interception of coalesced channel turns.
 *
 * The gate runs
 * once per coalesced turn between enrichment and the handler, a drop suppresses
 * only that turn, suspending inside the gate holds the whole drain because one
 * consumer fiber owns it, and a broken gate fails open.
 */

import { Effect, type Scope } from "effect";
import { expect, it, type MockInstance, vi } from "vitest";

import {
  buildMessage,
  createFakeChannelService,
  effectTest,
  type EnrichedInboundMessage,
  type FakeChannelService,
  FIRST_TEXT,
  flushDispatchChainEffect,
  type InboundInterceptDecision,
  message,
  type Message,
  MoltZapChannelCore,
  SECOND_TEXT,
} from "./channel-core-test-support.js";

const CONV_1 = "conv-1";
const CONV_2 = "conv-2";
const THIRD_TEXT = "third";
const DROP_REASON = "muted by policy";
const INTERCEPTOR_BOOM = "interceptor boom";

const deliver: InboundInterceptDecision = { _tag: "deliver" };

interface InterceptedCore {
  readonly fake: FakeChannelService;
  readonly core: MoltZapChannelCore;
  readonly seen: string[];
  readonly delivered: EnrichedInboundMessage[];
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

/**
 * Wire a core to an interceptor, recording every message the gate judged and
 * every turn that reached the handler.
 * @param intercept Gate under test.
 * @returns The fixture plus both observation sinks.
 */
function interceptedCore(
  intercept: (msg: Message) => Effect.Effect<InboundInterceptDecision>,
): InterceptedCore {
  const fake = createFakeChannelService({ ownAgentId: "agent-self" });
  setDmConversation(fake, CONV_1);
  setDmConversation(fake, CONV_2);
  const seen: string[] = [];
  const delivered: EnrichedInboundMessage[] = [];
  const core = new MoltZapChannelCore({
    service: fake.service,
    // Installed unwrapped so a gate that throws before returning an Effect
    // reaches the core exactly as a buggy embedder's would.
    inboundInterceptor: (msg) => {
      seen.push(msg.id);
      return intercept(msg);
    },
  });
  core.onInbound((msg) =>
    Effect.sync(() => {
      delivered.push(msg);
    }),
  );
  return { fake, core, seen, delivered };
}

function setDmConversation(fake: FakeChannelService, convId: string): void {
  fake.state.setConversation(convId, { type: "dm", participants: [] });
  fake.state.setAgentName("agent-alice", "Alice");
}

function dropsTurnAndKeepsDraining() {
  return Effect.gen(function* () {
    const { fake, seen, delivered } = interceptedCore((msg) =>
      Effect.succeed(
        msg.id === message("msg-1")
          ? { _tag: "drop", reason: DROP_REASON }
          : deliver,
      ),
    );

    emitText(fake, { id: "msg-1", conversationId: CONV_1 }, FIRST_TEXT);
    yield* flushDispatchChainEffect;
    emitText(fake, { id: "msg-2", conversationId: CONV_2 }, SECOND_TEXT);
    yield* flushDispatchChainEffect;

    expect(seen).toEqual([message("msg-1"), message("msg-2")]);
    expect(delivered.map((entry) => entry.id)).toEqual([message("msg-2")]);
  });
}

effectTest(
  "a dropped turn never reaches the handler and the next turn still drains",
  dropsTurnAndKeepsDraining,
);

function judgesTheNewestMessageOfACoalescedBatch() {
  return Effect.gen(function* () {
    const { fake, seen, delivered } = interceptedCore(() =>
      Effect.succeed(deliver),
    );

    emitText(fake, { id: "msg-1", conversationId: CONV_1 }, FIRST_TEXT);
    emitText(fake, { id: "msg-2", conversationId: CONV_1 }, SECOND_TEXT);
    emitText(fake, { id: "msg-3", conversationId: CONV_1 }, THIRD_TEXT);
    yield* flushDispatchChainEffect;

    // All three coalesce into one turn keyed on msg-1. The gate is consulted
    // once, on msg-3, and its verdict admits the whole batch.
    expect(seen).toEqual([message("msg-3")]);
    expect(delivered.map((entry) => entry.id)).toEqual([message("msg-1")]);
    const only =
      /* Safe because the assertion above fixes this turn's shape. */ delivered[0]!;
    expect(only.coalescedMessages?.map((entry) => entry.id)).toEqual([
      message("msg-1"),
      message("msg-2"),
      message("msg-3"),
    ]);
  });
}

effectTest(
  "judges the newest message of a coalesced batch",
  judgesTheNewestMessageOfACoalescedBatch,
);

function dropsTheWholeCoalescedBatch() {
  return Effect.gen(function* () {
    const { fake, delivered } = interceptedCore((msg) =>
      Effect.succeed(msg.id === message("msg-3") ? { _tag: "drop" } : deliver),
    );

    emitText(fake, { id: "msg-1", conversationId: CONV_1 }, FIRST_TEXT);
    yield* flushDispatchChainEffect;
    emitText(fake, { id: "msg-2", conversationId: CONV_1 }, SECOND_TEXT);
    emitText(fake, { id: "msg-3", conversationId: CONV_1 }, THIRD_TEXT);
    yield* flushDispatchChainEffect;

    expect(delivered.map((entry) => entry.id)).toEqual([message("msg-1")]);
  });
}

effectTest(
  "one drop verdict suppresses every message coalesced into that turn",
  dropsTheWholeCoalescedBatch,
);

interface InterceptorGate {
  readonly release: () => void;
}

function gatedInterceptor(): {
  readonly gate: InterceptorGate;
  readonly intercept: (msg: Message) => Effect.Effect<InboundInterceptDecision>;
} {
  const pending: Array<() => void> = [];
  const intercept = (): Effect.Effect<InboundInterceptDecision> =>
    Effect.async<InboundInterceptDecision>((resume) => {
      pending.push(() => {
        resume(Effect.succeed(deliver));
      });
    });
  return {
    gate: {
      release: () => {
        pending.shift()?.();
      },
    },
    intercept,
  };
}

function suspendingHoldsEverythingBehindIt() {
  return Effect.gen(function* () {
    const { gate, intercept } = gatedInterceptor();
    const { fake, seen, delivered } = interceptedCore(intercept);

    emitText(fake, { id: "msg-1", conversationId: CONV_1 }, FIRST_TEXT);
    yield* flushDispatchChainEffect;
    emitText(fake, { id: "msg-2", conversationId: CONV_2 }, SECOND_TEXT);
    yield* flushDispatchChainEffect;

    // One consumer fiber owns the drain, so a suspended gate parks its own
    // turn and every message queued behind it — the second turn is not even
    // offered to the gate yet.
    expect(seen).toEqual([message("msg-1")]);
    expect(delivered).toEqual([]);

    gate.release();
    yield* flushDispatchChainEffect;
    expect(seen).toEqual([message("msg-1"), message("msg-2")]);
    expect(delivered.map((entry) => entry.id)).toEqual([message("msg-1")]);

    gate.release();
    yield* flushDispatchChainEffect;
    expect(delivered.map((entry) => entry.id)).toEqual([
      message("msg-1"),
      message("msg-2"),
    ]);
  });
}

effectTest(
  "suspending inside the interceptor holds that turn and everything behind it",
  suspendingHoldsEverythingBehindIt,
);

/** Effect's string logger stamps the level it emitted at. */
const WARN_LEVEL = "level=WARN";

function capturedStdout(): Effect.Effect<
  MockInstance<typeof console.log>,
  never,
  Scope.Scope
> {
  return Effect.acquireRelease(
    Effect.sync(() =>
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ),
    (spy) =>
      Effect.sync(() => {
        spy.mockRestore();
      }),
  );
}

function deliversWhenTheInterceptorFails(
  intercept: (msg: Message) => Effect.Effect<InboundInterceptDecision>,
): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      // The consumer fiber runs on the default runtime, so its warnings land on
      // the default string logger's console sink rather than a test logger.
      const stdout = yield* capturedStdout();
      const { fake, delivered } = interceptedCore(intercept);

      emitText(fake, { id: "msg-1", conversationId: CONV_1 }, FIRST_TEXT);
      yield* flushDispatchChainEffect;

      expect(delivered.map((entry) => entry.id)).toEqual([message("msg-1")]);
      const logged = stdout.mock.calls.flat().join("\n");
      expect(logged).toContain(WARN_LEVEL);
      expect(logged).toContain(message("msg-1"));
      expect(logged).toContain(INTERCEPTOR_BOOM);
    }),
  );
}

it("delivers when the interceptor's Effect dies, and warns", () =>
  Effect.runPromise(
    deliversWhenTheInterceptorFails(() =>
      Effect.die(new Error(INTERCEPTOR_BOOM)),
    ),
  ));

it("delivers when the interceptor throws before returning an Effect", () =>
  Effect.runPromise(
    deliversWhenTheInterceptorFails(() => {
      throw new Error(INTERCEPTOR_BOOM);
    }),
  ));
