/** @file Gather overlay behavior against an in-process fake endpoint. */

import { it } from "@effect/vitest";
import {
  AgentAddress,
  type Content,
  type InboundDelivery,
  InboundMessage,
  type SendInput,
} from "@moltzap/client";
import {
  Effect,
  Encoding,
  FastCheck as fc,
  Fiber,
  Option,
  Queue,
  Schema,
  type Scope,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect } from "vitest";

import {
  closeContent,
  contributionContent,
  DELIVERY_DISPOSITION,
  GATHER_INPUT_FAILURE,
  type GatherInputError,
  type GatherOverlay,
  type GatherOverlayOptions,
  type GatherRequest,
  type GatherResult,
  makeGatherOverlay,
  requestContent,
} from "./gather-overlay.js";

const decodeAddress = Schema.decodeUnknownSync(AgentAddress);
const decodeMessage = Schema.decodeUnknownSync(InboundMessage);

const ROOT = decodeAddress("agent:root");
const ALICE = decodeAddress("agent:alice");
const BOB = decodeAddress("agent:bob");
const CAROL = decodeAddress("agent:carol");
const MALLORY = decodeAddress("agent:mallory");
const GROUP = "group:alice,bob,root";
const GROUP_MEMBERS = [ALICE, BOB, ROOT];
const GATHER_ID = "gather-1";
const DEADLINE = 1_000;
const CLOSE_WAIT = 500;
const THREE_DAYS_MILLIS = 3 * 24 * 60 * 60 * 1_000;
const PROPERTY_RUNS = 50;
const MONDAY = "Mon";
const TUESDAY = "Tue";
const MONDAY_ANSWER = contributionContent(GATHER_ID, MONDAY);
const TUESDAY_ANSWER = contributionContent(GATHER_ID, TUESDAY);
const OVER_LIMIT_MEMBERS = Array.from(Array(32).keys(), (index) =>
  decodeAddress(`agent:peer${index}`),
);

const PAIRWISE: GatherRequest = {
  members: [ALICE, BOB],
  prompt: "When can you meet?",
  deadlineAt: DEADLINE,
  topology: "pairwise",
};
const SHARED: GatherRequest = { ...PAIRWISE, topology: "shared" };
const TRIO: GatherRequest = { ...PAIRWISE, members: [ALICE, BOB, CAROL] };
const SENDER_POOL = [ALICE, BOB, CAROL, MALLORY];

/** A fake `send` and the queue of every input it saw. */
interface FakeSend {
  readonly sent: Queue.Queue<SendInput>;
  readonly send: (input: SendInput) => Effect.Effect<void>;
}

/** An open gather at the initiator, after its requests went out. */
interface OpenedGather {
  readonly overlay: GatherOverlay;
  readonly running: Fiber.RuntimeFiber<GatherResult, GatherInputError>;
}

/** One contribution in a generated shared-gather trace. */
interface SharedEntry {
  readonly sender: AgentAddress;
  readonly onGroup: boolean;
}

interface ObservedDelivery {
  readonly delivery: InboundDelivery;
  readonly acknowledgments: () => number;
}

/** A fake `send` that certifies instantly and reports each input it saw. */
const makeRecordingSend = Effect.map(
  Queue.unbounded<SendInput>(),
  (sent): FakeSend => ({
    sent,
    send: (input) => Effect.asVoid(Queue.offer(sent, input)),
  }),
);

/** A fake `send` whose peer never certifies, as when a daemon is down. */
const makeStalledSend = Effect.map(
  Queue.unbounded<SendInput>(),
  (sent): FakeSend => ({
    sent,
    send: (input) =>
      Queue.offer(sent, input).pipe(Effect.zipRight(Effect.never)),
  }),
);

const senderTrace = fc.array(fc.constantFrom(...SENDER_POOL), {
  maxLength: 12,
});
const sharedTrace = fc.array(
  fc.record({
    sender: fc.constantFrom(ALICE, BOB),
    onGroup: fc.boolean(),
  }),
  { maxLength: 8 },
);

describe("gather at the initiator", () => {
  it.scoped("returns every contribution once all members answered", () =>
    Effect.gen(function* () {
      const { overlay, running } = yield* startGather(PAIRWISE);

      yield* overlay.onDelivery(deliver(directMessage(ALICE, MONDAY_ANSWER)));
      yield* overlay.onDelivery(deliver(directMessage(BOB, TUESDAY_ANSWER)));
      const result = yield* Fiber.join(running);

      expect([...result.contributions.keys()]).toEqual([ALICE, BOB]);
      expect(result.missing).toEqual([]);
    }),
  );

  it.scoped("sends one request per member in the pairwise topology", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });
      yield* Effect.forkScoped(overlay.gather(PAIRWISE));

      const requests = yield* Queue.takeN(sent, 2);

      expect(new Set(addressesOf(requests))).toEqual(new Set([ALICE, BOB]));
    }),
  );

  it("counts each member's first contribution and nothing else", () =>
    fc.assert(
      fc.asyncProperty(senderTrace, (senders) =>
        runProperty(countsFirstMemberContributions(senders)),
      ),
      { numRuns: PROPERTY_RUNS },
    ));
});

describe("gather initiator deadlines", () => {
  it.scoped("returns a partial result naming the missing member", () =>
    Effect.gen(function* () {
      const { overlay, running } = yield* startGather(PAIRWISE);
      yield* overlay.onDelivery(deliver(directMessage(ALICE, MONDAY_ANSWER)));

      yield* TestClock.adjust(DEADLINE);
      const result = yield* Fiber.join(running);

      expect([...result.contributions.keys()]).toEqual([ALICE]);
      expect(result.missing).toEqual([BOB]);
    }),
  );

  it.scoped("returns at the deadline when no request send ever certifies", () =>
    Effect.gen(function* () {
      const { running } = yield* startGather(PAIRWISE, yield* makeStalledSend);

      yield* TestClock.adjust(DEADLINE);
      const result = yield* Fiber.join(running);

      expect(result.missing).toEqual([ALICE, BOB]);
    }),
  );

  it("returns at its deadline and not before while a member is silent", () =>
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: THREE_DAYS_MILLIS }),
        fc.subarray([ALICE, BOB, CAROL], { maxLength: 2 }),
        (deadlineAt, answered) =>
          runProperty(holdsUntilDeadline(deadlineAt, answered)),
      ),
      { numRuns: PROPERTY_RUNS },
    ));
});

describe("gathers with distant or past deadlines", () => {
  it.scoped("returns without sending when the deadline already passed", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });
      yield* TestClock.adjust(DEADLINE);

      const result = yield* overlay.gather(PAIRWISE);

      expect(result.missing).toEqual([ALICE, BOB]);
      expect(yield* Queue.size(sent)).toBe(0);
    }),
  );

  it.scoped(
    "completes a three-day gather as soon as the last member answers",
    () =>
      Effect.gen(function* () {
        const { overlay, running } = yield* startGather({
          ...PAIRWISE,
          deadlineAt: THREE_DAYS_MILLIS,
        });

        yield* overlay.onDelivery(deliver(directMessage(ALICE, MONDAY_ANSWER)));
        yield* overlay.onDelivery(deliver(directMessage(BOB, TUESDAY_ANSWER)));
        const result = yield* Fiber.join(running);

        expect(result.missing).toEqual([]);
      }),
  );
});

describe("gather input validation", () => {
  it.scoped("rejects an empty member list", () =>
    Effect.gen(function* () {
      const error = yield* rejectionOf({ ...PAIRWISE, members: [] });

      expect(error.reason).toBe(GATHER_INPUT_FAILURE.noMembers);
    }),
  );

  it.scoped("rejects more than 31 members", () =>
    Effect.gen(function* () {
      const error = yield* rejectionOf({
        ...PAIRWISE,
        members: OVER_LIMIT_MEMBERS,
      });

      expect(error.reason).toBe(GATHER_INPUT_FAILURE.tooManyMembers);
    }),
  );

  it.scoped("rejects a shared gather with a single member", () =>
    Effect.gen(function* () {
      const error = yield* rejectionOf({ ...SHARED, members: [ALICE] });

      expect(error.reason).toBe(GATHER_INPUT_FAILURE.sharedNeedsTwoMembers);
    }),
  );

  it("rejects any member list naming the caller without sending", () =>
    fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(ALICE, BOB, CAROL), { maxLength: 4 }),
        fc.nat(),
        fc.constantFrom("pairwise" as const, "shared" as const),
        (others, position, topology) =>
          runProperty(rejectsSelf(others, position, topology)),
      ),
      { numRuns: PROPERTY_RUNS },
    ));
});

describe("deliveries outside any gather", () => {
  it.scoped("passes through an ordinary message during an open gather", () =>
    Effect.gen(function* () {
      const { overlay } = yield* startGather(PAIRWISE);
      const ordinary = observe(
        directMessage(ALICE, [{ type: "text", text: "unrelated" }]),
      );

      const disposition = yield* overlay.onDelivery(ordinary.delivery);

      expect(disposition).toBe(DELIVERY_DISPOSITION.passthrough);
      expect(ordinary.acknowledgments()).toBe(0);
    }),
  );

  it.scoped("passes through a malformed gather data part", () =>
    Effect.gen(function* () {
      const { send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });
      const malformed = directMessage(ALICE, [
        { type: "data", value: { "moltzap.gather": { role: "contribution" } } },
      ]);

      const disposition = yield* overlay.onDelivery(deliver(malformed));

      expect(disposition).toBe(DELIVERY_DISPOSITION.passthrough);
    }),
  );

  it("passes through any text delivery unacknowledged", () =>
    fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), (text) =>
        runProperty(passesThroughText(text)),
      ),
      { numRuns: PROPERTY_RUNS },
    ));
});

describe("contributions the initiator declines", () => {
  it.scoped("passes through a contribution from an agent not asked", () =>
    Effect.gen(function* () {
      const { overlay } = yield* startGather(PAIRWISE);

      const disposition = yield* overlay.onDelivery(
        deliver(directMessage(MALLORY, MONDAY_ANSWER)),
      );

      expect(disposition).toBe(DELIVERY_DISPOSITION.passthrough);
      expect((yield* overlay.counters).outsider).toBe(1);
    }),
  );

  it.scoped("passes through a contribution for a gather it never opened", () =>
    Effect.gen(function* () {
      const { send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });

      const disposition = yield* overlay.onDelivery(
        deliver(directMessage(ALICE, contributionContent("unknown", MONDAY))),
      );

      expect(disposition).toBe(DELIVERY_DISPOSITION.passthrough);
      expect((yield* overlay.counters).unknownGather).toBe(1);
    }),
  );
});

describe("contributions the initiator counts once", () => {
  it.scoped(
    "passes through and counts a contribution to the wrong address",
    () =>
      Effect.gen(function* () {
        const { overlay } = yield* startGather(PAIRWISE);

        const disposition = yield* overlay.onDelivery(
          deliver(groupMessage(ALICE, MONDAY_ANSWER)),
        );

        expect(disposition).toBe(DELIVERY_DISPOSITION.passthrough);
        expect((yield* overlay.counters).wrongAddress).toBe(1);
      }),
  );

  it.scoped(
    "keeps a member's first contribution and passes through the second",
    () =>
      Effect.gen(function* () {
        const { overlay, running } = yield* startGather(PAIRWISE);
        yield* overlay.onDelivery(deliver(directMessage(ALICE, MONDAY_ANSWER)));

        const disposition = yield* overlay.onDelivery(
          deliver(directMessage(ALICE, TUESDAY_ANSWER)),
        );
        yield* TestClock.adjust(DEADLINE);
        const result = yield* Fiber.join(running);

        expect(disposition).toBe(DELIVERY_DISPOSITION.passthrough);
        expect(result.contributions.get(ALICE)).toEqual(MONDAY_ANSWER);
      }),
  );
});

describe("acknowledgment", () => {
  it.scoped("acknowledges an accepted contribution exactly once", () =>
    Effect.gen(function* () {
      const { overlay } = yield* startGather(PAIRWISE);
      const accepted = observe(directMessage(ALICE, MONDAY_ANSWER));

      const disposition = yield* overlay.onDelivery(accepted.delivery);

      expect(disposition).toBe(DELIVERY_DISPOSITION.consumed);
      expect(accepted.acknowledgments()).toBe(1);
    }),
  );
});

describe("contributor side", () => {
  it.scoped("answers a request on the address it arrived on", () =>
    Effect.gen(function* () {
      const { overlay, sent } = yield* makeResponder(ALICE, MONDAY);

      yield* overlay.onDelivery(deliver(pairwiseRequestTo(ALICE)));
      const reply = yield* Queue.take(sent);

      expect(reply).toEqual({ to: ROOT, content: MONDAY_ANSWER });
    }),
  );

  it.scoped("drops a request that arrives after its deadline", () =>
    Effect.gen(function* () {
      const { overlay, sent } = yield* makeResponder(ALICE, MONDAY);
      yield* TestClock.adjust(DEADLINE);

      const disposition = yield* overlay.onDelivery(
        deliver(pairwiseRequestTo(ALICE)),
      );

      expect(disposition).toBe(DELIVERY_DISPOSITION.consumed);
      expect(yield* Queue.size(sent)).toBe(0);
      expect((yield* overlay.counters).expiredRequest).toBe(1);
    }),
  );

  it.scoped(
    "hands a request to the model when no responder is configured",
    () =>
      Effect.gen(function* () {
        const { send } = yield* makeRecordingSend;
        const overlay = yield* makeGatherOverlay({ self: ALICE, send });

        const disposition = yield* overlay.onDelivery(
          deliver(pairwiseRequestTo(ALICE)),
        );

        expect(disposition).toBe(DELIVERY_DISPOSITION.passthrough);
      }),
  );
});

describe("shared close at the initiator", () => {
  it.scoped("posts a close record naming the contributors it counted", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingSend;
      const { overlay, running } = yield* startGather(SHARED, recording);
      yield* overlay.onDelivery(deliver(groupMessage(ALICE, MONDAY_ANSWER)));
      yield* overlay.onDelivery(deliver(groupMessage(BOB, TUESDAY_ANSWER)));

      const result = yield* Fiber.join(running);
      const close = yield* Queue.take(recording.sent);

      expect(result.closeCertified).toBe(true);
      expect(close).toEqual({
        to: GROUP,
        content: closeContent(GATHER_ID, [ALICE, BOB]),
      });
    }),
  );

  it("lists exactly the members whose first group contribution it counted", () =>
    fc.assert(
      fc.asyncProperty(sharedTrace, (entries) =>
        runProperty(closeListsCountedMembers(entries)),
      ),
      { numRuns: PROPERTY_RUNS },
    ));
});

describe("uncertified shared close", () => {
  it.scoped(
    "returns the listed contributors when another arrives in the close wait",
    () =>
      Effect.gen(function* () {
        const stalled = yield* makeStalledSend;
        const { overlay, running } = yield* startGather(SHARED, stalled);
        yield* overlay.onDelivery(deliver(groupMessage(ALICE, MONDAY_ANSWER)));
        yield* TestClock.adjust(DEADLINE);
        const close = yield* Queue.take(stalled.sent);

        yield* overlay.onDelivery(deliver(groupMessage(BOB, TUESDAY_ANSWER)));
        yield* TestClock.adjust(CLOSE_WAIT);
        const result = yield* Fiber.join(running);

        expect(close.content).toEqual(closeContent(GATHER_ID, [ALICE]));
        expect([...result.contributions.keys()]).toEqual([ALICE]);
        expect(result.closeCertified).toBe(false);
      }),
  );

  it.scoped("reports an uncertified close when the group is stalled", () =>
    Effect.gen(function* () {
      const stalled = yield* makeStalledSend;
      const { running } = yield* startGather(SHARED, stalled);

      yield* TestClock.adjust(DEADLINE);
      yield* Queue.take(stalled.sent);
      yield* TestClock.adjust(CLOSE_WAIT);
      const result = yield* Fiber.join(running);

      expect(result.closeCertified).toBe(false);
    }),
  );
});

describe("shared close at a peer member", () => {
  it.scoped(
    "gives a member only the contributions the close record lists",
    () =>
      Effect.gen(function* () {
        const overlay = yield* joinSharedGather(BOB);
        yield* overlay.onDelivery(deliver(groupMessage(ALICE, MONDAY_ANSWER)));

        yield* overlay.onDelivery(deliver(closeFromRoot([])));
        const result = yield* overlay.awaitMemberResult(GATHER_ID);

        expect([...result.keys()]).toEqual([]);
      }),
  );

  it.scoped("gives a member a listed peer contribution", () =>
    Effect.gen(function* () {
      const overlay = yield* joinSharedGather(BOB);
      yield* overlay.onDelivery(deliver(groupMessage(ALICE, MONDAY_ANSWER)));

      yield* overlay.onDelivery(deliver(closeFromRoot([ALICE])));
      const result = yield* overlay.awaitMemberResult(GATHER_ID);

      expect(result.get(ALICE)).toEqual(MONDAY_ANSWER);
    }),
  );

  it.scoped(
    "ignores a close record from a member that is not the initiator",
    () =>
      Effect.gen(function* () {
        const overlay = yield* joinSharedGather(BOB);

        const disposition = yield* overlay.onDelivery(
          deliver(groupMessage(ALICE, closeContent(GATHER_ID, [ALICE]))),
        );

        expect(disposition).toBe(DELIVERY_DISPOSITION.passthrough);
      }),
  );
});

describe("shared close at a responding member", () => {
  it.scoped(
    "counts its own listed contribution although it is never delivered",
    () =>
      Effect.gen(function* () {
        const { overlay, sent } = yield* makeResponder(BOB, TUESDAY);
        yield* overlay.onDelivery(deliver(sharedRequest()));
        yield* Queue.take(sent);

        yield* overlay.onDelivery(deliver(closeFromRoot([BOB])));
        const result = yield* overlay.awaitMemberResult(GATHER_ID);

        expect(result.get(BOB)).toEqual(TUESDAY_ANSWER);
      }),
  );

  it.scoped(
    "leaves out its own contribution when the close record omits it",
    () =>
      Effect.gen(function* () {
        const { overlay, sent } = yield* makeResponder(BOB, TUESDAY);
        yield* overlay.onDelivery(deliver(sharedRequest()));
        yield* Queue.take(sent);

        yield* overlay.onDelivery(deliver(closeFromRoot([])));
        const result = yield* overlay.awaitMemberResult(GATHER_ID);

        expect(result.has(BOB)).toBe(false);
      }),
  );
});

/**
 * A ROOT overlay whose gathers use GATHER_ID, forked into `request` and
 * resumed once every request send has been attempted, so the gather is open
 * before a test delivers to it.
 */
function startGather(
  request: GatherRequest,
  fake?: FakeSend,
): Effect.Effect<OpenedGather, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { sent, send } = fake ?? (yield* makeRecordingSend);
    const overlay = yield* makeGatherOverlay({
      self: ROOT,
      send,
      mintId: () => GATHER_ID,
      closeWaitMillis: CLOSE_WAIT,
    });
    const running = yield* Effect.forkScoped(overlay.gather(request));
    yield* Queue.takeN(sent, requestSendCount(request));
    return { overlay, running };
  });
}

function requestSendCount(request: GatherRequest): number {
  return request.topology === "shared" ? 1 : request.members.length;
}

function addressesOf(inputs: Iterable<SendInput>): Array<SendInput["to"]> {
  return Array.from(inputs, (input) => input.to);
}

/**
 * Deliver `senders` in order as contributions to a three-member pairwise
 * gather, then check the result against the first answer each member gave.
 */
function countsFirstMemberContributions(
  senders: readonly AgentAddress[],
): Effect.Effect<void, GatherInputError, Scope.Scope> {
  return Effect.gen(function* () {
    const { overlay, running } = yield* startGather(TRIO);
    yield* Effect.forEach(
      senders.entries(),
      ([index, sender]) =>
        overlay.onDelivery(deliver(directMessage(sender, answer(index)))),
      { concurrency: 1, discard: true },
    );
    yield* TestClock.adjust(DEADLINE);
    const result = yield* Fiber.join(running);
    const expected = firstMemberAnswers(senders);

    expect(result.contributions).toEqual(expected);
    expect(result.missing).toEqual(
      TRIO.members.filter((member) => !expected.has(member)),
    );
  });
}

function firstMemberAnswers(
  senders: readonly AgentAddress[],
): ReadonlyMap<AgentAddress, Content> {
  const answers = new Map<AgentAddress, Content>();
  for (const [index, sender] of senders.entries()) {
    if (TRIO.members.includes(sender) && !answers.has(sender)) {
      answers.set(sender, answer(index));
    }
  }
  return answers;
}

function answer(index: number): Content {
  return contributionContent(GATHER_ID, `answer ${index}`);
}

/** Answer from `answered` only, then watch the gather across its deadline. */
function holdsUntilDeadline(
  deadlineAt: number,
  answered: readonly AgentAddress[],
): Effect.Effect<void, GatherInputError, Scope.Scope> {
  return Effect.gen(function* () {
    const { overlay, running } = yield* startGather({ ...TRIO, deadlineAt });
    yield* Effect.forEach(
      answered,
      (member) =>
        overlay.onDelivery(deliver(directMessage(member, MONDAY_ANSWER))),
      { concurrency: 1, discard: true },
    );

    yield* TestClock.adjust(deadlineAt - 1);
    const beforeDeadline = yield* Fiber.poll(running);
    yield* TestClock.adjust(1);
    const result = yield* Fiber.join(running);

    expect(Option.isNone(beforeDeadline)).toBe(true);
    expect(result.missing).toEqual(
      TRIO.members.filter((member) => !answered.includes(member)),
    );
  });
}

function rejectionOf(request: GatherRequest) {
  return Effect.gen(function* () {
    const { send } = yield* makeRecordingSend;
    const overlay = yield* makeGatherOverlay({ self: ROOT, send });
    return yield* Effect.flip(overlay.gather(request));
  });
}

/** Insert the caller at `position` among `others` and gather from the list. */
function rejectsSelf(
  others: readonly AgentAddress[],
  position: number,
  topology: GatherRequest["topology"],
): Effect.Effect<void, GatherResult, Scope.Scope> {
  return Effect.gen(function* () {
    const { sent, send } = yield* makeRecordingSend;
    const overlay = yield* makeGatherOverlay({ self: ROOT, send });
    const at = position % (others.length + 1);
    const members = [...others.slice(0, at), ROOT, ...others.slice(at)];

    const error = yield* Effect.flip(
      overlay.gather({ ...PAIRWISE, members, topology }),
    );

    expect(error.reason).toBe(GATHER_INPUT_FAILURE.selfInMembers);
    expect(yield* Queue.size(sent)).toBe(0);
  });
}

function passesThroughText(
  text: string,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { overlay } = yield* startGather(PAIRWISE);
    const ordinary = observe(directMessage(ALICE, [{ type: "text", text }]));

    const disposition = yield* overlay.onDelivery(ordinary.delivery);

    expect(disposition).toBe(DELIVERY_DISPOSITION.passthrough);
    expect(ordinary.acknowledgments()).toBe(0);
  });
}

/**
 * Deliver `entries` to a shared gather, on the group or directly, and check
 * that the close record lists each member whose first group post arrived.
 */
function closeListsCountedMembers(
  entries: readonly SharedEntry[],
): Effect.Effect<void, GatherInputError, Scope.Scope> {
  return Effect.gen(function* () {
    const recording = yield* makeRecordingSend;
    const { overlay, running } = yield* startGather(SHARED, recording);
    yield* Effect.forEach(
      entries,
      (entry) => overlay.onDelivery(deliver(sharedEntryMessage(entry))),
      { concurrency: 1, discard: true },
    );
    yield* TestClock.adjust(DEADLINE);
    const result = yield* Fiber.join(running);
    const close = yield* Queue.take(recording.sent);
    const counted = [
      ...new Set(
        entries.filter((entry) => entry.onGroup).map((entry) => entry.sender),
      ),
    ];

    expect(close.content).toEqual(closeContent(GATHER_ID, counted));
    expect([...result.contributions.keys()]).toEqual(counted);
  });
}

function sharedEntryMessage(entry: SharedEntry): InboundMessage {
  return entry.onGroup
    ? groupMessage(entry.sender, MONDAY_ANSWER)
    : directMessage(entry.sender, MONDAY_ANSWER);
}

function makeResponder(self: AgentAddress, reply: string) {
  return Effect.gen(function* () {
    const { sent, send } = yield* makeRecordingSend;
    const options: GatherOverlayOptions = {
      self,
      send,
      respond: () => Effect.succeed(Option.some(reply)),
    };
    const overlay = yield* makeGatherOverlay(options);
    return { overlay, sent };
  });
}

/** A model-backed overlay for `self` that has seen ROOT's shared request. */
function joinSharedGather(self: AgentAddress) {
  return Effect.gen(function* () {
    const { send } = yield* makeRecordingSend;
    const overlay = yield* makeGatherOverlay({ self, send });
    yield* overlay.onDelivery(deliver(sharedRequest()));
    return overlay;
  });
}

function pairwiseRequestTo(member: AgentAddress): InboundMessage {
  return directMessage(ROOT, requestContent(GATHER_ID, PAIRWISE, member));
}

function sharedRequest(): InboundMessage {
  return groupMessage(ROOT, requestContent(GATHER_ID, SHARED, GROUP));
}

function closeFromRoot(included: readonly AgentAddress[]): InboundMessage {
  return groupMessage(ROOT, closeContent(GATHER_ID, included));
}

function directMessage(sender: AgentAddress, content: Content): InboundMessage {
  return decodeMessage({
    kind: "direct",
    postId: nextPostId(),
    address: sender,
    sender,
    content,
  });
}

function groupMessage(sender: AgentAddress, content: Content): InboundMessage {
  return decodeMessage({
    kind: "group",
    postId: nextPostId(),
    address: GROUP,
    sender,
    members: GROUP_MEMBERS,
    content,
  });
}

let postCounter = 0;

function nextPostId(): string {
  postCounter += 1;
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, postCounter);
  return `pst_${Encoding.encodeBase64Url(bytes)}`;
}

function deliver(message: InboundMessage): InboundDelivery {
  return observe(message).delivery;
}

function observe(message: InboundMessage): ObservedDelivery {
  let count = 0;
  return {
    delivery: {
      message,
      acknowledge: Effect.sync(() => {
        count += 1;
      }),
    },
    acknowledgments: () => count,
  };
}

/** Run one property case with its own scope and test clock. */
function runProperty<E>(scenario: Effect.Effect<void, E, Scope.Scope>) {
  return Effect.runPromise(
    scenario.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
  );
}
