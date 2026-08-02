import { assert, effect as test } from "@effect/vitest";
import type { AgentId } from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import { Chunk, Duration, Effect, Mailbox, Stream, TestClock } from "effect";
import type { EventOf } from "../events/catalog.js";
import {
  type linkEvents,
  LinkMessageDelayed,
  LinkMessageDropped,
  LinkMessageHeld,
} from "../events/core.js";
import type { LedgerWriter } from "../ledger/live.js";
import {
  linkPolicy,
  type InboundLinkStage,
  type NetworkOperation,
} from "../network.js";
import {
  makeLinkFabric,
  type InboundLinkInterceptor,
  type LinkFabric,
} from "./link-fabric.js";

type LinkEventWriter = LedgerWriter<typeof linkEvents>;
const aliceId = agentId("00000000-0000-4000-8000-000000000001");
const bobId = agentId("00000000-0000-4000-8000-000000000002");
const carolId = agentId("00000000-0000-4000-8000-000000000003");
const CONVERSATION = conversationId("00000000-0000-4000-8000-000000000200");
const SHAPE_LINK_OPERATION: NetworkOperation = "shape-link";
const DISABLE_LINK_OPERATION: NetworkOperation = "disable-link";
const ENABLE_LINK_OPERATION: NetworkOperation = "enable-link";
const DROP_REASON = "partition";
const FIRST_REASON = "first";
const SECOND_REASON = "second";
const DELAY = Duration.millis(100);
const LONGER_DELAY = Duration.millis(200);
const DELAY_MILLIS = 100;
const SUMMED_DELAY_MILLIS = 300;

function message(senderId: AgentId, suffix: number): Message {
  return {
    id: messageId(
      `00000000-0000-4000-8000-${String(300 + suffix).padStart(12, "0")}`,
    ),
    conversationId: CONVERSATION,
    senderId,
    parts: [{ type: "text", text: `message ${String(suffix)}` }],
    createdAt: "2026-07-28T00:00:00.000Z",
  };
}

function eventWriter(
  events: Array<EventOf<typeof linkEvents>>,
): LinkEventWriter {
  return {
    write: ({ event }) =>
      Effect.sync(() => {
        events.push(event);
        return {
          runId: "fabric-test",
          eventId: `event-${String(events.length)}`,
          logicalSequence: events.length - 1,
          elapsedNanos: 0n,
          observedAt: 0,
          producer: "kernel.link",
          event,
        };
      }),
  };
}

interface Harness {
  readonly events: Array<EventOf<typeof linkEvents>>;
  readonly fabric: LinkFabric;
  readonly mailbox: Mailbox.Mailbox<{ readonly message: Message }>;
  readonly delivered: string[];
}

function makeHarness() {
  return Effect.gen(function* () {
    const events: Array<EventOf<typeof linkEvents>> = [];
    const delivered: string[] = [];
    const fabric = yield* makeLinkFabric(eventWriter(events));
    const interceptor: InboundLinkInterceptor = fabric.interceptor;
    const stage: InboundLinkStage = yield* interceptor.attach(bobId);
    const mailbox = yield* Mailbox.make<{ readonly message: Message }>();
    yield* stage(Mailbox.toStream(mailbox)).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          delivered.push(item.message.id);
        }),
      ),
      Effect.forkScoped,
    );
    return { events, fabric, mailbox, delivered } satisfies Harness;
  });
}

function send(harness: Harness, item: Message) {
  return harness.mailbox.offer({ message: item });
}

function awaitUntil(predicate: () => boolean): Effect.Effect<void> {
  return Effect.suspend(() =>
    predicate()
      ? Effect.void
      : Effect.yieldNow().pipe(Effect.zipRight(awaitUntil(predicate))),
  );
}

function awaitSleepers(count: number): Effect.Effect<void> {
  return TestClock.sleeps().pipe(
    Effect.flatMap((sleeps) =>
      Chunk.size(sleeps) >= count
        ? Effect.void
        : Effect.yieldNow().pipe(
            Effect.zipRight(Effect.suspend(() => awaitSleepers(count))),
          ),
    ),
  );
}

function droppedEvents(harness: Harness): LinkMessageDropped[] {
  return harness.events.filter((event) => event instanceof LinkMessageDropped);
}

function delayedEvents(harness: Harness): LinkMessageDelayed[] {
  return harness.events.filter((event) => event instanceof LinkMessageDelayed);
}

function heldEvents(harness: Harness): LinkMessageHeld[] {
  return harness.events.filter((event) => event instanceof LinkMessageHeld);
}

// @agent-code-guard/regression-only: deterministic latches, TestClock control, and array writers expose exact per-pair verdict, ordering, and evidence semantics
test("drop-all drops only the shaped pair and records evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const lease = yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.dropAll(DROP_REASON),
        "drop alice to bob",
      );
      const droppedMessage = message(aliceId, 1);
      const passing = message(carolId, 2);
      yield* send(harness, droppedMessage);
      yield* send(harness, passing);
      yield* awaitUntil(() => droppedEvents(harness).length === 1);
      yield* awaitUntil(() => harness.delivered.length === 1);

      const evidence = droppedEvents(harness)[0];
      assert.strictEqual(evidence?.from, aliceId);
      assert.strictEqual(evidence?.to, bobId);
      assert.strictEqual(evidence?.messageId, droppedMessage.id);
      assert.strictEqual(evidence?.reason, DROP_REASON);
      assert.deepStrictEqual(harness.delivered, [passing.id]);

      yield* lease.clear;
      const revived = message(aliceId, 3);
      yield* send(harness, revived);
      yield* awaitUntil(() => harness.delivered.length === 2);
      assert.deepStrictEqual(harness.delivered, [passing.id, revived.id]);
    }),
  ));

test("delays deliveries by the intended total under the ambient clock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.delay(DELAY),
        "delay",
      );
      const delayed = message(aliceId, 1);
      yield* send(harness, delayed);
      yield* awaitUntil(() => delayedEvents(harness).length === 1);
      yield* awaitSleepers(1);

      assert.deepStrictEqual(harness.delivered, []);
      assert.strictEqual(delayedEvents(harness)[0]?.delayMillis, DELAY_MILLIS);

      yield* TestClock.adjust(DELAY);
      yield* awaitUntil(() => harness.delivered.length === 1);
      assert.deepStrictEqual(harness.delivered, [delayed.id]);
    }),
  ));

test("holds park deliveries and release preserves per-sender order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const lease = yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.hold,
        "hold",
      );
      const first = message(aliceId, 1);
      const second = message(aliceId, 2);
      yield* send(harness, first);
      yield* send(harness, second);
      yield* awaitUntil(() => heldEvents(harness).length === 1);

      assert.deepStrictEqual(harness.delivered, []);
      assert.strictEqual(heldEvents(harness)[0]?.messageId, first.id);

      yield* lease.clear;
      yield* awaitUntil(() => harness.delivered.length === 2);
      assert.deepStrictEqual(harness.delivered, [first.id, second.id]);
      assert.lengthOf(heldEvents(harness), 1);
    }),
  ));

test("released holds re-evaluate against the then-active chain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const lease = yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.hold,
        "hold",
      );
      const parked = message(aliceId, 1);
      yield* send(harness, parked);
      yield* awaitUntil(() => heldEvents(harness).length === 1);

      yield* harness.fabric.driver.disable(aliceId, bobId);
      yield* lease.clear;
      yield* awaitUntil(() => droppedEvents(harness).length === 1);

      assert.strictEqual(droppedEvents(harness)[0]?.messageId, parked.id);
      assert.deepStrictEqual(harness.delivered, []);
    }),
  ));

test("a drop dominates delays wherever it sits in the chain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.delay(DELAY),
        "delay",
      );
      yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.dropAll(DROP_REASON),
        "drop",
      );
      yield* send(harness, message(aliceId, 1));
      yield* awaitUntil(() => droppedEvents(harness).length === 1);

      assert.lengthOf(delayedEvents(harness), 0);
      assert.deepStrictEqual(harness.delivered, []);
    }),
  ));

test("stacked delays record one summed total", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.delay(DELAY),
        "short delay",
      );
      yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.delay(LONGER_DELAY),
        "long delay",
      );
      const delayed = message(aliceId, 1);
      yield* send(harness, delayed);
      yield* awaitUntil(() => delayedEvents(harness).length === 1);
      yield* awaitSleepers(1);

      assert.strictEqual(
        delayedEvents(harness)[0]?.delayMillis,
        SUMMED_DELAY_MILLIS,
      );

      yield* TestClock.adjust(Duration.millis(SUMMED_DELAY_MILLIS));
      yield* awaitUntil(() => harness.delivered.length === 1);
      assert.deepStrictEqual(harness.delivered, [delayed.id]);
    }),
  ));

test("the first installed drop supplies the recorded reason", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.dropAll(FIRST_REASON),
        "first drop",
      );
      yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.dropAll(SECOND_REASON),
        "second drop",
      );
      yield* send(harness, message(aliceId, 1));
      yield* awaitUntil(() => droppedEvents(harness).length === 1);

      assert.strictEqual(droppedEvents(harness)[0]?.reason, FIRST_REASON);
    }),
  ));

test("an active delay keeps per-sender FIFO without blocking other senders", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.fabric.driver.apply(
        aliceId,
        bobId,
        linkPolicy.delay(DELAY),
        "delay",
      );
      const firstDelayed = message(aliceId, 1);
      const secondDelayed = message(aliceId, 2);
      const undelayed = message(carolId, 3);
      yield* send(harness, firstDelayed);
      yield* send(harness, secondDelayed);
      yield* send(harness, undelayed);
      yield* awaitUntil(() => harness.delivered.length === 1);

      assert.deepStrictEqual(harness.delivered, [undelayed.id]);

      yield* awaitSleepers(1);
      yield* TestClock.adjust(DELAY);
      yield* awaitUntil(() => harness.delivered.length === 2);
      yield* awaitSleepers(1);
      yield* TestClock.adjust(DELAY);
      yield* awaitUntil(() => harness.delivered.length === 3);

      assert.deepStrictEqual(harness.delivered, [
        undelayed.id,
        firstDelayed.id,
        secondDelayed.id,
      ]);
      assert.lengthOf(delayedEvents(harness), 2);
    }),
  ));

test("shaping an unregistered receiver fails fast", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const applyFailure = yield* harness.fabric.driver
        .apply(aliceId, carolId, linkPolicy.hold, "hold")
        .pipe(Effect.flip);
      const disableFailure = yield* harness.fabric.driver
        .disable(aliceId, carolId)
        .pipe(Effect.flip);

      assert.strictEqual(applyFailure.operation, SHAPE_LINK_OPERATION);
      assert.strictEqual(disableFailure.operation, DISABLE_LINK_OPERATION);
    }),
  ));

test("disable installs a clearable drop and enable restores delivery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.fabric.driver.disable(aliceId, bobId);
      const blocked = message(aliceId, 1);
      yield* send(harness, blocked);
      yield* awaitUntil(() => droppedEvents(harness).length === 1);

      assert.strictEqual(droppedEvents(harness)[0]?.messageId, blocked.id);
      assert.deepStrictEqual(harness.delivered, []);

      yield* harness.fabric.driver.enable(aliceId, bobId);
      const restored = message(aliceId, 2);
      yield* send(harness, restored);
      yield* awaitUntil(() => harness.delivered.length === 1);
      assert.deepStrictEqual(harness.delivered, [restored.id]);

      const repeated = yield* harness.fabric.driver
        .enable(aliceId, bobId)
        .pipe(Effect.flip);
      assert.strictEqual(repeated.operation, ENABLE_LINK_OPERATION);
    }),
  ));
