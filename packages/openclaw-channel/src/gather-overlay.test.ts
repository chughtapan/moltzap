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
  Fiber,
  Option,
  Queue,
  Schema,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";

import {
  contributionContent,
  type GatherRequest,
  makeGatherOverlay,
  requestContent,
} from "./gather-overlay.js";

const decodeAddress = Schema.decodeUnknownSync(AgentAddress);
const decodeMessage = Schema.decodeUnknownSync(InboundMessage);

const ROOT = decodeAddress("agent:root");
const ALICE = decodeAddress("agent:alice");
const BOB = decodeAddress("agent:bob");
const MALLORY = decodeAddress("agent:mallory");
const GROUP = "group:alice,bob,root";
const GROUP_MEMBERS = [ALICE, BOB, ROOT];
const GATHER_ID = "gather-1";
const DEADLINE = 1_000;
const THREE_DAYS_MILLIS = 3 * 24 * 60 * 60 * 1_000;

const PAIRWISE: GatherRequest = {
  members: [ALICE, BOB],
  prompt: "When can you meet?",
  deadlineAt: DEADLINE,
  topology: "pairwise",
};
const SHARED: GatherRequest = { ...PAIRWISE, topology: "shared" };

let postCounter = 0;

function nextPostId(): string {
  postCounter += 1;
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, postCounter);
  return `pst_${Encoding.encodeBase64Url(bytes)}`;
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

interface ObservedDelivery {
  readonly delivery: InboundDelivery;
  readonly acknowledgments: () => number;
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

function deliver(message: InboundMessage): InboundDelivery {
  return observe(message).delivery;
}

/** A fake `send` that certifies instantly and reports each input it saw. */
const makeRecordingSend = Effect.map(Queue.unbounded<SendInput>(), (sent) => ({
  sent,
  send: (input: SendInput) => Effect.asVoid(Queue.offer(sent, input)),
}));

/** A fake `send` whose peer never certifies, as when a daemon is down. */
const makeStalledSend = Effect.map(Queue.unbounded<SendInput>(), (sent) => ({
  sent,
  send: (input: SendInput) =>
    Queue.offer(sent, input).pipe(Effect.zipRight(Effect.never)),
}));

describe("gather at the initiator", () => {
  it.scoped("returns every contribution once all members answered", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({
        self: ROOT,
        send,
        mintId: () => GATHER_ID,
      });
      const running = yield* Effect.forkScoped(overlay.gather(PAIRWISE));
      yield* Queue.takeN(sent, 2);

      yield* overlay.onDelivery(
        deliver(directMessage(ALICE, contributionContent(GATHER_ID, "Mon"))),
      );
      yield* overlay.onDelivery(
        deliver(directMessage(BOB, contributionContent(GATHER_ID, "Tue"))),
      );
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

      expect(new Set([...requests].map((input) => input.to))).toEqual(
        new Set([ALICE, BOB]),
      );
    }),
  );

  it.scoped(
    "returns a partial result naming the missing member at the deadline",
    () =>
      Effect.gen(function* () {
        const { sent, send } = yield* makeRecordingSend;
        const overlay = yield* makeGatherOverlay({
          self: ROOT,
          send,
          mintId: () => GATHER_ID,
        });
        const running = yield* Effect.forkScoped(overlay.gather(PAIRWISE));
        yield* Queue.takeN(sent, 2);
        yield* overlay.onDelivery(
          deliver(directMessage(ALICE, contributionContent(GATHER_ID, "Mon"))),
        );

        yield* TestClock.adjust(DEADLINE);
        const result = yield* Fiber.join(running);

        expect([...result.contributions.keys()]).toEqual([ALICE]);
        expect(result.missing).toEqual([BOB]);
      }),
  );

  it.scoped("returns at the deadline when no request send ever certifies", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeStalledSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });
      const running = yield* Effect.forkScoped(overlay.gather(PAIRWISE));
      yield* Queue.takeN(sent, 2);

      yield* TestClock.adjust(DEADLINE);
      const result = yield* Fiber.join(running);

      expect(result.missing).toEqual([ALICE, BOB]);
    }),
  );

  it.scoped(
    "returns immediately without sending when the deadline already passed",
    () =>
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
        const { sent, send } = yield* makeRecordingSend;
        const overlay = yield* makeGatherOverlay({
          self: ROOT,
          send,
          mintId: () => GATHER_ID,
        });
        const running = yield* Effect.fork(
          overlay.gather({ ...PAIRWISE, deadlineAt: THREE_DAYS_MILLIS }),
        );
        yield* Queue.takeN(sent, 2);

        yield* overlay.onDelivery(
          deliver(directMessage(ALICE, contributionContent(GATHER_ID, "Mon"))),
        );
        yield* overlay.onDelivery(
          deliver(directMessage(BOB, contributionContent(GATHER_ID, "Tue"))),
        );
        const result = yield* Fiber.join(running);

        expect(result.missing).toEqual([]);
      }),
  );

  it.scoped("holds a three-day gather open until its deadline", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });
      const running = yield* Effect.fork(
        overlay.gather({ ...PAIRWISE, deadlineAt: THREE_DAYS_MILLIS }),
      );
      yield* Queue.takeN(sent, 2);

      yield* TestClock.adjust(THREE_DAYS_MILLIS - 1);
      const beforeDeadline = yield* Fiber.poll(running);
      yield* TestClock.adjust(1);
      const result = yield* Fiber.join(running);

      expect(Option.isNone(beforeDeadline)).toBe(true);
      expect(result.missing).toEqual([ALICE, BOB]);
    }),
  );
});

describe("gather input validation", () => {
  it.scoped("rejects an empty member list", () =>
    Effect.gen(function* () {
      const { send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });

      const error = yield* Effect.flip(
        overlay.gather({ ...PAIRWISE, members: [] }),
      );

      expect(error.reason).toBe("no-members");
    }),
  );

  it.scoped("rejects the caller naming itself as a member", () =>
    Effect.gen(function* () {
      const { send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });

      const error = yield* Effect.flip(
        overlay.gather({ ...PAIRWISE, members: [ALICE, ROOT] }),
      );

      expect(error.reason).toBe("self-in-members");
    }),
  );

  it.scoped("rejects more than 31 members", () =>
    Effect.gen(function* () {
      const { send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });
      const members = Array.from({ length: 32 }, (unused, index) =>
        decodeAddress(`agent:peer${index}`),
      );

      const error = yield* Effect.flip(
        overlay.gather({ ...PAIRWISE, members }),
      );

      expect(error.reason).toBe("too-many-members");
    }),
  );

  it.scoped("rejects a shared gather with a single member", () =>
    Effect.gen(function* () {
      const { send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });

      const error = yield* Effect.flip(
        overlay.gather({ ...SHARED, members: [ALICE] }),
      );

      expect(error.reason).toBe("shared-needs-two-members");
    }),
  );
});

describe("deliveries the overlay declines", () => {
  it.scoped("passes through an ordinary message during an open gather", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });
      yield* Effect.forkScoped(overlay.gather(PAIRWISE));
      yield* Queue.takeN(sent, 2);
      const ordinary = observe(
        directMessage(ALICE, [{ type: "text", text: "unrelated" }]),
      );

      const disposition = yield* overlay.onDelivery(ordinary.delivery);

      expect(disposition).toBe("passthrough");
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

      expect(disposition).toBe("passthrough");
    }),
  );

  it.scoped(
    "passes through a contribution from an agent that was not asked",
    () =>
      Effect.gen(function* () {
        const { sent, send } = yield* makeRecordingSend;
        const overlay = yield* makeGatherOverlay({
          self: ROOT,
          send,
          mintId: () => GATHER_ID,
        });
        yield* Effect.forkScoped(overlay.gather(PAIRWISE));
        yield* Queue.takeN(sent, 2);

        const disposition = yield* overlay.onDelivery(
          deliver(directMessage(MALLORY, contributionContent(GATHER_ID, "Me"))),
        );

        expect(disposition).toBe("passthrough");
        expect((yield* overlay.counters).outsider).toBe(1);
      }),
  );

  it.scoped("passes through a contribution for a gather it never opened", () =>
    Effect.gen(function* () {
      const { send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: ROOT, send });

      const disposition = yield* overlay.onDelivery(
        deliver(directMessage(ALICE, contributionContent("unknown", "Mon"))),
      );

      expect(disposition).toBe("passthrough");
      expect((yield* overlay.counters).unknownGather).toBe(1);
    }),
  );

  it.scoped(
    "passes through and counts a contribution sent to the wrong address",
    () =>
      Effect.gen(function* () {
        const { sent, send } = yield* makeRecordingSend;
        const overlay = yield* makeGatherOverlay({
          self: ROOT,
          send,
          mintId: () => GATHER_ID,
        });
        yield* Effect.forkScoped(overlay.gather(PAIRWISE));
        yield* Queue.takeN(sent, 2);

        const disposition = yield* overlay.onDelivery(
          deliver(groupMessage(ALICE, contributionContent(GATHER_ID, "Mon"))),
        );

        expect(disposition).toBe("passthrough");
        expect((yield* overlay.counters).wrongAddress).toBe(1);
      }),
  );

  it.scoped(
    "keeps a member's first contribution and passes through the second",
    () =>
      Effect.gen(function* () {
        const { sent, send } = yield* makeRecordingSend;
        const overlay = yield* makeGatherOverlay({
          self: ROOT,
          send,
          mintId: () => GATHER_ID,
        });
        const running = yield* Effect.forkScoped(overlay.gather(PAIRWISE));
        yield* Queue.takeN(sent, 2);
        const first = contributionContent(GATHER_ID, "Mon");
        yield* overlay.onDelivery(deliver(directMessage(ALICE, first)));

        const disposition = yield* overlay.onDelivery(
          deliver(directMessage(ALICE, contributionContent(GATHER_ID, "Fri"))),
        );
        yield* TestClock.adjust(DEADLINE);
        const result = yield* Fiber.join(running);

        expect(disposition).toBe("passthrough");
        expect(result.contributions.get(ALICE)).toEqual(first);
      }),
  );
});

describe("acknowledgment", () => {
  it.scoped("acknowledges an accepted contribution exactly once", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({
        self: ROOT,
        send,
        mintId: () => GATHER_ID,
      });
      yield* Effect.forkScoped(overlay.gather(PAIRWISE));
      yield* Queue.takeN(sent, 2);
      const accepted = observe(
        directMessage(ALICE, contributionContent(GATHER_ID, "Mon")),
      );

      const disposition = yield* overlay.onDelivery(accepted.delivery);

      expect(disposition).toBe("consumed");
      expect(accepted.acknowledgments()).toBe(1);
    }),
  );
});

describe("contributor side", () => {
  it.scoped("answers a request on the address it arrived on", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({
        self: ALICE,
        send,
        respond: () => Effect.succeed(Option.some("Mon")),
      });

      yield* overlay.onDelivery(
        deliver(
          directMessage(ROOT, requestContent(GATHER_ID, PAIRWISE, ALICE)),
        ),
      );
      const reply = yield* Queue.take(sent);

      expect(reply).toEqual({
        to: ROOT,
        content: contributionContent(GATHER_ID, "Mon"),
      });
    }),
  );

  it.scoped("drops a request that arrives after its deadline", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({
        self: ALICE,
        send,
        respond: () => Effect.succeed(Option.some("Mon")),
      });
      yield* TestClock.adjust(DEADLINE);

      const disposition = yield* overlay.onDelivery(
        deliver(
          directMessage(ROOT, requestContent(GATHER_ID, PAIRWISE, ALICE)),
        ),
      );

      expect(disposition).toBe("consumed");
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
          deliver(
            directMessage(ROOT, requestContent(GATHER_ID, PAIRWISE, ALICE)),
          ),
        );

        expect(disposition).toBe("passthrough");
      }),
  );
});

describe("shared topology", () => {
  it.scoped("posts one group request and a close record", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({
        self: ROOT,
        send,
        mintId: () => GATHER_ID,
      });
      const running = yield* Effect.forkScoped(overlay.gather(SHARED));
      yield* Queue.take(sent);
      yield* overlay.onDelivery(
        deliver(groupMessage(ALICE, contributionContent(GATHER_ID, "Mon"))),
      );
      yield* overlay.onDelivery(
        deliver(groupMessage(BOB, contributionContent(GATHER_ID, "Tue"))),
      );

      const result = yield* Fiber.join(running);
      const close = yield* Queue.take(sent);

      expect(result.closeCertified).toBe(true);
      expect(close.to).toBe(GROUP);
    }),
  );

  it.scoped("reports an uncertified close when the group is stalled", () =>
    Effect.gen(function* () {
      const { sent, send } = yield* makeStalledSend;
      const overlay = yield* makeGatherOverlay({
        self: ROOT,
        send,
        closeWaitMillis: 500,
      });
      const running = yield* Effect.forkScoped(overlay.gather(SHARED));
      yield* Queue.take(sent);

      yield* TestClock.adjust(DEADLINE);
      yield* Queue.take(sent);
      yield* TestClock.adjust(500);
      const result = yield* Fiber.join(running);

      expect(result.closeCertified).toBe(false);
    }),
  );

  it.scoped("excludes a contribution ordered after the close record", () =>
    Effect.gen(function* () {
      const { send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: BOB, send });
      yield* overlay.onDelivery(
        deliver(groupMessage(ROOT, requestContent(GATHER_ID, SHARED, GROUP))),
      );
      yield* overlay.onDelivery(
        deliver(
          groupMessage(ROOT, [
            {
              type: "data",
              value: { "moltzap.gather": { id: GATHER_ID, role: "close" } },
            },
          ]),
        ),
      );

      yield* overlay.onDelivery(
        deliver(groupMessage(ALICE, contributionContent(GATHER_ID, "Late"))),
      );
      const result = yield* overlay.awaitMemberResult(GATHER_ID);

      expect([...result.keys()]).toEqual([]);
    }),
  );

  it.scoped("includes a contribution ordered before the close record", () =>
    Effect.gen(function* () {
      const { send } = yield* makeRecordingSend;
      const overlay = yield* makeGatherOverlay({ self: BOB, send });
      yield* overlay.onDelivery(
        deliver(groupMessage(ROOT, requestContent(GATHER_ID, SHARED, GROUP))),
      );
      yield* overlay.onDelivery(
        deliver(groupMessage(ALICE, contributionContent(GATHER_ID, "Mon"))),
      );

      yield* overlay.onDelivery(
        deliver(
          groupMessage(ROOT, [
            {
              type: "data",
              value: { "moltzap.gather": { id: GATHER_ID, role: "close" } },
            },
          ]),
        ),
      );
      const result = yield* overlay.awaitMemberResult(GATHER_ID);

      expect([...result.keys()]).toEqual([ALICE]);
    }),
  );

  it.scoped(
    "ignores a close record from a member that is not the initiator",
    () =>
      Effect.gen(function* () {
        const { send } = yield* makeRecordingSend;
        const overlay = yield* makeGatherOverlay({ self: BOB, send });
        yield* overlay.onDelivery(
          deliver(groupMessage(ROOT, requestContent(GATHER_ID, SHARED, GROUP))),
        );

        const disposition = yield* overlay.onDelivery(
          deliver(
            groupMessage(ALICE, [
              {
                type: "data",
                value: { "moltzap.gather": { id: GATHER_ID, role: "close" } },
              },
            ]),
          ),
        );

        expect(disposition).toBe("passthrough");
      }),
  );
});
