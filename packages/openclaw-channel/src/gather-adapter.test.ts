/** @file Gather adapter behavior: model-written JSON in, one result turn out. */

import { it } from "@effect/vitest";
import {
  AgentAddress,
  type Content,
  type InboundDelivery,
  InboundMessage,
  SendError,
  type SendInput,
} from "@moltzap/client";
import {
  Chunk,
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

import {
  type GatherAdapter,
  type GatherReport,
  makeGatherAdapter,
} from "./gather-adapter.js";
import {
  closeContent,
  contributionContent,
  DELIVERY_DISPOSITION,
  type GatherInputError,
  type GatherRequest,
  GatherStartError,
  requestContent,
} from "./gather-overlay.js";

const decodeAddress = Schema.decodeUnknownSync(AgentAddress);
const decodeMessage = Schema.decodeUnknownSync(InboundMessage);

const ROOT = decodeAddress("agent:root");
const ALICE = decodeAddress("agent:alice");
const BOB = decodeAddress("agent:bob");
const CAROL = decodeAddress("agent:carol");
const GROUP = "group:alice,bob,root";
const DEADLINE_SECONDS = 60;
const GATHER_ID = "gather-9";
const PROPERTY_RUNS = 25;
const MEMBER_NAMES = ["alice", "bob", "carol", "dave"];
const MONDAY = "Mon";
const TUESDAY = "Tue";

const PAIRWISE_COMMAND = gatherCommand(["alice", "bob"]);
const NOT_AN_ADDRESS = "Sarah Smith";
const NOT_ADDRESSES = [NOT_AN_ADDRESS, "Bob", "carol agent", "agent:"];

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
  readonly turns: Queue.Queue<GatherReport>;
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

describe("gather adapter unreachable members", () => {
  it.scoped("fails a gather naming a member that is not an address", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* makeHarness("root");

      const error = yield* Effect.flip(
        runCommand(adapter, ALICE, gatherCommand(["alice", NOT_AN_ADDRESS])),
      );

      expect(error).toEqual(
        new GatherStartError({
          failures: [{ member: NOT_AN_ADDRESS, reason: "invalid-address" }],
        }),
      );
      expect(yield* Queue.size(sent)).toBe(0);
    }),
  );

  it.scoped("fails a gather naming a member the Router does not know", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness("root", BOB);

      const error = yield* Effect.flip(
        runCommand(adapter, ALICE, PAIRWISE_COMMAND),
      );

      expect(error).toEqual(
        new GatherStartError({
          failures: [{ member: BOB, reason: "unknown-agent" }],
        }),
      );
    }),
  );

  it.scoped("runs no result turn for a gather that failed to start", () =>
    Effect.gen(function* () {
      const { adapter, turns } = yield* makeHarness("root", BOB);
      yield* Effect.flip(runCommand(adapter, ALICE, PAIRWISE_COMMAND));

      yield* TestClock.adjust(DEADLINE_SECONDS * 1_000);

      expect(yield* Queue.size(turns)).toBe(0);
    }),
  );

  it("fails a gather naming any member that is not an address", () =>
    fc.assert(
      fc.asyncProperty(
        fc.subarray(MEMBER_NAMES),
        fc.constantFrom(...NOT_ADDRESSES),
        fc.nat(),
        (names, invalid, position) =>
          runProperty(rejectsInvalidMember(names, invalid, position)),
      ),
      { numRuns: PROPERTY_RUNS },
    ));
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

        expect(turn.text).toContain(`${ALICE}: ${MONDAY}`);
        expect(turn.text).toContain(`${BOB}: ${TUESDAY}`);
        expect(yield* Queue.size(turns)).toBe(0);
      }),
  );

  it("names the gather, every answer and every silent member in its result", () =>
    fc.assert(
      fc.asyncProperty(
        fc.subarray([ALICE, BOB, CAROL], { minLength: 1, maxLength: 2 }),
        (answered) => runProperty(reportsAnswersAndMissing(answered)),
      ),
      { numRuns: PROPERTY_RUNS },
    ));
});

describe("gather adapter result sender", () => {
  it.scoped("reports the result as the local agent, not a member", () =>
    Effect.gen(function* () {
      const { adapter, sent, turns } = yield* makeHarness("root");
      const id = yield* startTrio(adapter, sent);
      yield* adapter.onDelivery(direct(ALICE, contributionContent(id, MONDAY)));

      yield* TestClock.adjust(DEADLINE_SECONDS * 1_000);
      const turn = yield* Queue.take(turns);

      expect(turn.from).toBe(ROOT);
    }),
  );

  it.scoped("gives the result an identity no contribution carries", () =>
    Effect.gen(function* () {
      const { adapter, sent, turns } = yield* makeHarness("root");
      const id = yield* startTrio(adapter, sent);
      const contributions = trioAnswers(id);

      yield* deliverAll(adapter, contributions);
      const turn = yield* Queue.take(turns);

      expect(postIdsOf(contributions)).not.toContain(turn.turnId);
    }),
  );
});

describe("gather adapter late contributions", () => {
  it.scoped("runs no turn for an answer after the result", () =>
    Effect.gen(function* () {
      const { adapter, sent, turns } = yield* makeHarness("root");
      const id = yield* startTrio(adapter, sent);
      yield* TestClock.adjust(DEADLINE_SECONDS * 1_000);
      yield* Queue.take(turns);

      const disposition = yield* adapter.onDelivery(
        direct(ALICE, contributionContent(id, MONDAY)),
      );

      expect(disposition).toBe(DELIVERY_DISPOSITION.consumed);
      expect(yield* Queue.size(turns)).toBe(0);
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

        expect(turn.text).toContain(`${ALICE}: ${MONDAY}`);
      }),
  );
});

describe("gather adapter close report at a shared-gather member", () => {
  it.scoped("reports the close as the local agent, naming the gather", () =>
    Effect.gen(function* () {
      const { adapter, turns } = yield* makeHarness("bob");
      yield* adapter.onDelivery(sharedRequest());

      yield* adapter.onDelivery(group(ROOT, closeContent(GATHER_ID, [])));
      const turn = yield* Queue.take(turns);

      expect(turn).toEqual({
        turnId: `gather:${GATHER_ID}:close`,
        from: BOB,
        text: `Gather ${GATHER_ID} from ${ROOT} closed (collected by the MoltZap gather, not a message from any one person). Every member holds these same answers:\n- no answers`,
      });
    }),
  );
});

/**
 * Gather from alice, bob and carol, deliver an answer from each of
 * `answered`, let the deadline pass, and check that the result lists exactly
 * those answers and names every other member as missing.
 */
function reportsAnswersAndMissing(
  answered: readonly AgentAddress[],
): Effect.Effect<
  void,
  SendError | GatherInputError | GatherStartError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const { adapter, sent, turns } = yield* makeHarness("root");
    const id = yield* startTrio(adapter, sent);
    yield* deliverAll(
      adapter,
      answered.map((member) => direct(member, contributionContent(id, member))),
    );

    yield* TestClock.adjust(DEADLINE_SECONDS * 1_000);
    const turn = yield* Queue.take(turns);

    const silent = [ALICE, BOB, CAROL].filter(
      (member) => !answered.includes(member),
    );
    expect(turn.text).toBe(
      [
        `Gather ${id} result (collected by the MoltZap gather, not a message from any one person):`,
        ...answered.map((member) => `- ${member}: ${member}`),
        `No answer from: ${silent.join(", ")}.`,
        "These are all the answers; no further replies are coming for it.",
      ].join("\n"),
    );
  });
}

function trioAnswers(id: string): readonly InboundDelivery[] {
  return [
    direct(ALICE, contributionContent(id, MONDAY)),
    direct(BOB, contributionContent(id, TUESDAY)),
    direct(CAROL, contributionContent(id, MONDAY)),
  ];
}

function deliverAll(
  adapter: GatherAdapter,
  deliveries: readonly InboundDelivery[],
): Effect.Effect<void> {
  return Effect.forEach(
    deliveries,
    (delivery) => adapter.onDelivery(delivery),
    {
      concurrency: 1,
      discard: true,
    },
  );
}

function postIdsOf(deliveries: readonly InboundDelivery[]): readonly string[] {
  return deliveries.map((delivery) => delivery.message.postId);
}

/** Start a pairwise gather to alice, bob and carol and return its id. */
function startTrio(
  adapter: GatherAdapter,
  sent: Queue.Queue<SendInput>,
): Effect.Effect<string, SendError | GatherInputError | GatherStartError> {
  return Effect.gen(function* () {
    yield* runCommand(adapter, ROOT, gatherCommand(["alice", "bob", "carol"]));
    const requests = yield* Queue.takeN(sent, 3);
    return gatherIdOf(Chunk.unsafeHead(requests));
  });
}

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

/**
 * An adapter for `agentName` with a recording send and a recording turn
 * runner. A send to `unknown` fails as the Router reports an agent it does not
 * know.
 */
function makeHarness(
  agentName: string,
  unknown?: AgentAddress,
): Effect.Effect<Harness, never, Scope.Scope> {
  return Effect.gen(function* () {
    const sent = yield* Queue.unbounded<SendInput>();
    const turns = yield* Queue.unbounded<GatherReport>();
    const adapter = yield* makeGatherAdapter({
      send: (input) =>
        input.to === unknown
          ? Effect.fail(new SendError({ reason: "unknown-agent" }))
          : Effect.asVoid(Queue.offer(sent, input)),
      runTurn: (report) => Effect.asVoid(Queue.offer(turns, report)),
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

/**
 * Insert `invalid` at `position` among valid `names`, gather from the list,
 * and check that the command fails naming only `invalid` and sends nothing.
 */
function rejectsInvalidMember(
  names: readonly string[],
  invalid: string,
  position: number,
): Effect.Effect<void, void, Scope.Scope> {
  return Effect.gen(function* () {
    const { adapter, sent } = yield* makeHarness("root");
    const at = position % (names.length + 1);
    const members = [...names.slice(0, at), invalid, ...names.slice(at)];

    const error = yield* Effect.flip(
      runCommand(adapter, ROOT, gatherCommand(members)),
    );

    expect(error).toEqual(
      new GatherStartError({
        failures: [{ member: invalid, reason: "invalid-address" }],
      }),
    );
    expect(yield* Queue.size(sent)).toBe(0);
  });
}

function gatherIdOf(request: SendInput): string {
  const match = /Gather (\S+):/u.exec(
    request.content[0].type === "text" ? request.content[0].text : "",
  );
  return match?.[1] ?? "";
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
