/**
 * Raw scheduled-turn delivery preserves the channel core's serialized queue
 * semantics while leaving presentation enrichment and markers to its client.
 */

import { live as it } from "@effect/vitest";
import { Data, Deferred, Effect } from "effect";
import { expect, vi } from "vitest";

import {
  FIRST_TEXT,
  SECOND_TEXT,
  buildMessage,
  conversation,
  createFakeChannelService,
  flushDispatchChainEffect,
  message,
  MoltZapChannelCore,
  type EnrichedInboundMessage,
  type FakeChannelService,
  type Message,
} from "./channel-core-test-support.js";

const CONV_1 = "conv-1";
const CONV_2 = "conv-2";
const THIRD_TEXT = "third";
const HANDLER_TIMEOUT_MS = 20;

class RawHandlerTestError extends Data.TaggedError("RawHandlerTestError")<{
  readonly message: string;
}> {}

function emitText(
  fake: FakeChannelService,
  spec: { readonly id: string; readonly conversationId: string },
  text: string,
): Message {
  const raw = buildMessage({
    id: spec.id,
    conversationId: spec.conversationId,
    parts: [{ type: "text", text }],
  });
  fake.emit.message(raw);
  return raw;
}

function awaitSignal(
  deferred: Deferred.Deferred<undefined>,
): Effect.Effect<void> {
  return Deferred.await(deferred).pipe(Effect.asVoid);
}

function expectCoalescedRawBatches(
  batches: ReadonlyArray<readonly Message[]>,
  originals: readonly [Message, Message, Message],
  intercepted: readonly string[],
): void {
  expect(batches).toHaveLength(2);
  expect(batches.map((batch) => batch.map((raw) => raw.id))).toEqual([
    [message("msg-1")],
    [message("msg-2"), message("msg-3")],
  ]);
  expect(batches[0]?.[0]).toBe(originals[0]);
  expect(batches[1]?.[0]).toBe(originals[1]);
  expect(batches[1]?.[1]).toBe(originals[2]);
  expect(intercepted).toEqual([message("msg-1"), message("msg-3")]);
}

function rawBatchesCoalesceExistingMessages() {
  return Effect.gen(function* () {
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const intercepted: string[] = [];
    const core = new MoltZapChannelCore({
      service: fake.service,
      inboundInterceptor: (raw) =>
        Effect.sync(() => {
          intercepted.push(raw.id);
          return { _tag: "deliver" } as const;
        }),
    });
    const firstStarted = yield* Deferred.make<undefined>();
    const releaseFirst = yield* Deferred.make<undefined>();
    const secondHandled = yield* Deferred.make<undefined>();
    const batches: Array<readonly Message[]> = [];
    core.onRawInbound((messages) =>
      Effect.gen(function* () {
        batches.push(messages);
        if (batches.length === 1) {
          yield* Deferred.succeed(firstStarted, undefined);
          yield* awaitSignal(releaseFirst);
          return;
        }
        yield* Deferred.succeed(secondHandled, undefined);
      }),
    );

    const first = emitText(
      fake,
      { id: "msg-1", conversationId: CONV_1 },
      FIRST_TEXT,
    );
    yield* awaitSignal(firstStarted);
    const second = emitText(
      fake,
      { id: "msg-2", conversationId: CONV_1 },
      SECOND_TEXT,
    );
    const third = emitText(
      fake,
      { id: "msg-3", conversationId: CONV_1 },
      THIRD_TEXT,
    );
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* awaitSignal(secondHandled);

    expectCoalescedRawBatches(batches, [first, second, third], intercepted);
  });
}

it(
  "onRawInbound receives the existing same-conversation batch after interception",
  rawBatchesCoalesceExistingMessages,
);

function rawBatchesKeepOtherConversationsInOrder() {
  return Effect.gen(function* () {
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const core = new MoltZapChannelCore({ service: fake.service });
    const firstStarted = yield* Deferred.make<undefined>();
    const releaseFirst = yield* Deferred.make<undefined>();
    const allHandled = yield* Deferred.make<undefined>();
    const batches: Array<readonly Message[]> = [];
    core.onRawInbound((messages) =>
      Effect.gen(function* () {
        batches.push(messages);
        if (batches.length === 1) {
          yield* Deferred.succeed(firstStarted, undefined);
          yield* awaitSignal(releaseFirst);
          return;
        }
        if (batches.length === 3) {
          yield* Deferred.succeed(allHandled, undefined);
        }
      }),
    );

    emitText(fake, { id: "msg-1", conversationId: CONV_1 }, FIRST_TEXT);
    yield* awaitSignal(firstStarted);
    emitText(fake, { id: "msg-other", conversationId: CONV_2 }, "elsewhere");
    emitText(fake, { id: "msg-2", conversationId: CONV_1 }, SECOND_TEXT);
    emitText(fake, { id: "msg-3", conversationId: CONV_1 }, THIRD_TEXT);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* awaitSignal(allHandled);

    expect(batches.map((batch) => batch.map((raw) => raw.id))).toEqual([
      [message("msg-1")],
      [message("msg-other")],
      [message("msg-2"), message("msg-3")],
    ]);
    expect(batches.map((batch) => batch[0]?.conversationId)).toEqual([
      conversation(CONV_1),
      conversation(CONV_2),
      conversation(CONV_1),
    ]);
  });
}

it(
  "onRawInbound keeps other conversations in arrival order",
  rawBatchesKeepOtherConversationsInOrder,
);

function observeEnrichmentReads(fake: FakeChannelService) {
  return [
    vi.spyOn(fake.service, "getConversation"),
    vi.spyOn(fake.service, "getAgentName"),
    vi.spyOn(fake.service, "resolveAgentName"),
    vi.spyOn(fake.service, "peekContextEntries"),
    vi.spyOn(fake.service, "peekFullMessages"),
  ];
}

function seedPresentationContext(fake: FakeChannelService): void {
  fake.state.setConversation(CONV_1, { type: "dm", participants: [] });
  fake.state.setAgentName("agent-alice", "Alice");
  fake.state.setContextEntries(CONV_1, [
    {
      conversationId: CONV_2,
      senderName: "Bob",
      text: "context summary",
      minutesAgo: 1,
      count: 1,
    },
  ]);
  fake.state.setFullMessages(CONV_1, [
    {
      conversationId: conversation(CONV_2),
      senderName: "Bob",
      senderId: "agent-bob",
      text: "full context",
      timestamp: "2026-08-03T00:00:00.000Z",
    },
  ]);
}

function rawDeliveryDoesNotAdvancePresentationMarkers() {
  return Effect.gen(function* () {
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const enrichmentCalls = observeEnrichmentReads(fake);
    seedPresentationContext(fake);
    const core = new MoltZapChannelCore({ service: fake.service });
    const rawHandled = yield* Deferred.make<undefined>();
    core.onRawInbound(() => Deferred.succeed(rawHandled, undefined));

    emitText(fake, { id: "msg-raw", conversationId: CONV_1 }, FIRST_TEXT);
    yield* awaitSignal(rawHandled);

    for (const call of enrichmentCalls) {
      expect(call).not.toHaveBeenCalled();
    }

    const enrichedHandled = yield* Deferred.make<undefined>();
    const enriched: EnrichedInboundMessage[] = [];
    core.onInbound((incoming) =>
      Effect.sync(() => {
        enriched.push(incoming);
      }).pipe(Effect.zipRight(Deferred.succeed(enrichedHandled, undefined))),
    );
    emitText(fake, { id: "msg-enriched", conversationId: CONV_1 }, SECOND_TEXT);
    yield* awaitSignal(enrichedHandled);

    expect(enriched[0]?.contextBlocks.crossConversation).toHaveLength(1);
    expect(enriched[0]?.contextBlocks.crossConversationMessages).toHaveLength(
      1,
    );
  });
}

it(
  "raw delivery leaves presentation markers for a later enriched turn",
  rawDeliveryDoesNotAdvancePresentationMarkers,
);

function rawHandlerFailureKeepsTheConsumerAlive() {
  return Effect.gen(function* () {
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const core = new MoltZapChannelCore({ service: fake.service });
    const nextHandled = yield* Deferred.make<undefined>();
    core.onRawInbound((messages) =>
      messages[0]?.id === message("msg-failed")
        ? Effect.fail(
            new RawHandlerTestError({ message: "raw handler failed" }),
          )
        : Deferred.succeed(nextHandled, undefined),
    );

    emitText(fake, { id: "msg-failed", conversationId: CONV_1 }, FIRST_TEXT);
    yield* flushDispatchChainEffect;
    emitText(fake, { id: "msg-next", conversationId: CONV_2 }, SECOND_TEXT);
    yield* awaitSignal(nextHandled);
  });
}

it(
  "a failed raw handler does not stop the next turn",
  rawHandlerFailureKeepsTheConsumerAlive,
);

function rawHandlerTimeoutKeepsTheConsumerAlive() {
  return Effect.gen(function* () {
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const core = new MoltZapChannelCore({
      service: fake.service,
      turnTimeoutMs: HANDLER_TIMEOUT_MS,
    });
    const nextHandled = yield* Deferred.make<undefined>();
    core.onRawInbound((messages) =>
      messages[0]?.id === message("msg-stuck")
        ? Effect.never
        : Deferred.succeed(nextHandled, undefined),
    );

    emitText(fake, { id: "msg-stuck", conversationId: CONV_1 }, FIRST_TEXT);
    yield* flushDispatchChainEffect;
    emitText(fake, { id: "msg-next", conversationId: CONV_2 }, SECOND_TEXT);
    yield* awaitSignal(nextHandled);
  });
}

it(
  "a timed-out raw handler releases the serialized drain",
  rawHandlerTimeoutKeepsTheConsumerAlive,
);
