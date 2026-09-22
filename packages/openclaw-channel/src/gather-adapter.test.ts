/** @file Gather adapter behavior: model-written JSON in, one result turn out. */

import { it } from "@effect/vitest";
import {
  AgentAddress,
  type Content,
  type InboundDelivery,
  InboundMessage,
  type SendInput,
} from "@moltzap/client";
import {
  ConfigProvider,
  Effect,
  Encoding,
  FastCheck as fc,
  Option,
  Queue,
  Schema,
  type Scope,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect } from "vitest";

import { type GatherAdapter, makeGatherAdapter } from "./gather-adapter.js";
import {
  closeContent,
  contributionContent,
  DELIVERY_DISPOSITION,
  type GatherRequest,
  requestContent,
} from "./gather-overlay.js";

const decodeAddress = Schema.decodeUnknownSync(AgentAddress);
const decodeMessage = Schema.decodeUnknownSync(InboundMessage);

const ROOT = decodeAddress("agent:root");
const ALICE = decodeAddress("agent:alice");
const BOB = decodeAddress("agent:bob");
const GROUP = "group:alice,bob,root";
const DEADLINE_SECONDS = 60;
const GATHER_ID = "gather-9";
const PROPERTY_RUNS = 25;
const MEMBER_NAMES = ["alice", "bob", "carol", "dave"];
const MONDAY = "Mon";
const TUESDAY = "Tue";

const PAIRWISE_COMMAND = gatherCommand(["alice", "bob"]);

const SHARED_REQUEST: GatherRequest = {
  members: [ALICE, BOB],
  prompt: "When can you meet?",
  deadlineAt: DEADLINE_SECONDS * 1_000,
  topology: "shared",
};

/** The recording adapter a test drives. */
interface Harness {
  readonly adapter: GatherAdapter;
  readonly sent: Queue.Queue<SendInput>;
  readonly turns: Queue.Queue<InboundMessage>;
}

describe("gather adapter configuration", () => {
  it.scoped("stays off when the local agent name is not configured", () =>
    Effect.gen(function* () {
      const adapter = yield* makeGatherAdapter({
        send: () => Effect.void,
        runTurn: () => Effect.void,
        log: () => undefined,
      }).pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map())));

      expect(Option.isNone(adapter)).toBe(true);
    }),
  );
});

describe("gather adapter outbound", () => {
  it.scoped("leaves ordinary message text to the stock send path", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness("root");

      const command = adapter.commandSend(ALICE, "See you Monday.");

      expect(Option.isNone(command)).toBe(true);
    }),
  );

  it.scoped("accepts a gather document wrapped in a code fence", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* makeHarness("root");

      yield* runCommand(
        adapter,
        ALICE,
        `\`\`\`json\n${PAIRWISE_COMMAND}\n\`\`\``,
      );

      expect([...(yield* Queue.takeN(sent, 2))]).toHaveLength(2);
    }),
  );

  it("fans a pairwise gather document out to exactly the named members", () =>
    fc.assert(
      fc.asyncProperty(fc.subarray(MEMBER_NAMES, { minLength: 1 }), (names) =>
        runProperty(fansOutToNamedMembers(names)),
      ),
      { numRuns: PROPERTY_RUNS },
    ));
});

describe("gather adapter send callback", () => {
  it.scoped("returns from the send before any contribution arrives", () =>
    Effect.gen(function* () {
      const { adapter, turns } = yield* makeHarness("root");

      yield* runCommand(adapter, ALICE, PAIRWISE_COMMAND);

      expect(yield* Queue.size(turns)).toBe(0);
    }),
  );

  it.scoped("sends a contribution document to the target the model named", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* makeHarness("alice");
      const text = JSON.stringify({
        contribution: { id: GATHER_ID },
        message: MONDAY,
      });

      yield* runCommand(adapter, ROOT, text);

      expect(yield* Queue.take(sent)).toEqual({
        to: ROOT,
        content: contributionContent(GATHER_ID, MONDAY),
      });
    }),
  );
});

describe("gather adapter result turn", () => {
  it.scoped(
    "runs one turn carrying every answer once all members replied",
    () =>
      Effect.gen(function* () {
        const { adapter, sent, turns } = yield* makeHarness("root");
        yield* runCommand(adapter, ALICE, PAIRWISE_COMMAND);
        const id = gatherIdOf(yield* Queue.take(sent));
        yield* Queue.take(sent);

        yield* adapter.onDelivery(
          direct(ALICE, contributionContent(id, MONDAY)),
        );
        yield* adapter.onDelivery(
          direct(BOB, contributionContent(id, TUESDAY)),
        );
        const turn = yield* Queue.take(turns);

        expect(textOf(turn)).toContain(`${ALICE}: ${MONDAY}`);
        expect(textOf(turn)).toContain(`${BOB}: ${TUESDAY}`);
        expect(yield* Queue.size(turns)).toBe(0);
      }),
  );

  it.scoped(
    "names the members that never answered when the deadline passes",
    () =>
      Effect.gen(function* () {
        const { adapter, sent, turns } = yield* makeHarness("root");
        yield* runCommand(adapter, ALICE, PAIRWISE_COMMAND);
        yield* Queue.takeN(sent, 2);

        yield* TestClock.adjust(DEADLINE_SECONDS * 1_000);
        const turn = yield* Queue.take(turns);

        expect(textOf(turn)).toContain(`${ALICE}, ${BOB}`);
      }),
  );
});

describe("gather adapter at a shared-gather member", () => {
  it.scoped("hands the request to the model", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness("bob");

      const disposition = yield* adapter.onDelivery(sharedRequest());

      expect(disposition).toBe(DELIVERY_DISPOSITION.passthrough);
    }),
  );

  it.scoped("withholds a peer's contribution from the model", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness("bob");
      yield* adapter.onDelivery(sharedRequest());

      const disposition = yield* adapter.onDelivery(
        group(ALICE, contributionContent(GATHER_ID, MONDAY)),
      );

      expect(disposition).toBe(DELIVERY_DISPOSITION.consumed);
    }),
  );

  it.scoped(
    "runs one turn with the agreed answers when the close arrives",
    () =>
      Effect.gen(function* () {
        const { adapter, turns } = yield* makeHarness("bob");
        yield* adapter.onDelivery(sharedRequest());
        yield* adapter.onDelivery(
          group(ALICE, contributionContent(GATHER_ID, MONDAY)),
        );

        yield* adapter.onDelivery(
          group(ROOT, closeContent(GATHER_ID, [ALICE])),
        );
        const turn = yield* Queue.take(turns);

        expect(textOf(turn)).toContain(`${ALICE}: ${MONDAY}`);
      }),
  );
});

function gatherCommand(members: readonly string[]): string {
  return JSON.stringify({
    gather: {
      members,
      deadlineSeconds: DEADLINE_SECONDS,
      topology: "pairwise",
    },
    message: "When can you meet?",
  });
}

/** An adapter for `agentName` with a recording send and a recording turn runner. */
function makeHarness(
  agentName: string,
): Effect.Effect<Harness, never, Scope.Scope> {
  return Effect.gen(function* () {
    const sent = yield* Queue.unbounded<SendInput>();
    const turns = yield* Queue.unbounded<InboundMessage>();
    const adapter = yield* makeGatherAdapter({
      send: (input) => Effect.asVoid(Queue.offer(sent, input)),
      runTurn: (message) => Effect.asVoid(Queue.offer(turns, message)),
      log: () => undefined,
    }).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["MOLTZAP_AGENT_NAME", agentName]])),
      ),
      Effect.map(Option.getOrThrow),
    );
    return { adapter, sent, turns };
  });
}

function runCommand(adapter: GatherAdapter, to: AgentAddress, text: string) {
  return Option.getOrThrow(adapter.commandSend(to, text));
}

/** Gather from `names` and check that one request goes to each of them. */
function fansOutToNamedMembers(
  names: readonly string[],
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { adapter, sent } = yield* makeHarness("root");

    yield* Effect.orDie(runCommand(adapter, ROOT, gatherCommand(names)));
    const requests = yield* Queue.takeN(sent, names.length);

    expect(new Set(Array.from(requests, (input) => input.to))).toEqual(
      new Set(names.map((name) => `agent:${name}`)),
    );
  });
}

function gatherIdOf(request: SendInput): string {
  const match = /Gather (\S+):/u.exec(
    request.content[0].type === "text" ? request.content[0].text : "",
  );
  return match?.[1] ?? "";
}

function textOf(message: InboundMessage): string {
  const first = message.content[0];
  return first.type === "text" ? first.text : "";
}

function sharedRequest(): InboundDelivery {
  return group(ROOT, requestContent(GATHER_ID, SHARED_REQUEST, GROUP));
}

function direct(sender: AgentAddress, content: Content): InboundDelivery {
  return {
    message: decodeMessage({
      kind: "direct",
      postId: nextPostId(),
      address: sender,
      sender,
      content,
    }),
    acknowledge: Effect.void,
  };
}

function group(sender: AgentAddress, content: Content): InboundDelivery {
  return {
    message: decodeMessage({
      kind: "group",
      postId: nextPostId(),
      address: GROUP,
      sender,
      members: [ALICE, BOB, ROOT],
      content,
    }),
    acknowledge: Effect.void,
  };
}

let postCounter = 0;

function nextPostId(): string {
  postCounter += 1;
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, postCounter);
  return `pst_${Encoding.encodeBase64Url(bytes)}`;
}

/** Run one property case with its own scope and test clock. */
function runProperty<E>(scenario: Effect.Effect<void, E, Scope.Scope>) {
  return Effect.runPromise(
    scenario.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
  );
}
