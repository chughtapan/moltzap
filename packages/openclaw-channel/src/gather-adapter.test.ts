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
  Option,
  Queue,
  Schema,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";

import { type GatherAdapter, makeGatherAdapter } from "./gather-adapter.js";
import {
  closeContent,
  contributionContent,
  requestContent,
} from "./gather-overlay.js";

const decodeAddress = Schema.decodeUnknownSync(AgentAddress);
const decodeMessage = Schema.decodeUnknownSync(InboundMessage);

const ROOT = decodeAddress("agent:root");
const ALICE = decodeAddress("agent:alice");
const BOB = decodeAddress("agent:bob");
const GROUP = "group:alice,bob,root";
const DEADLINE_SECONDS = 60;

const PAIRWISE_COMMAND = JSON.stringify({
  gather: {
    members: ["alice", "bob"],
    deadlineSeconds: DEADLINE_SECONDS,
    topology: "pairwise",
  },
  message: "When can you meet?",
});

let postCounter = 0;

function nextPostId(): string {
  postCounter += 1;
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, postCounter);
  return `pst_${Encoding.encodeBase64Url(bytes)}`;
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

/** An adapter for `agentName` with a recording send and a recording turn runner. */
function makeHarness(agentName: string) {
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

  it.scoped("fans a gather document out to every named member", () =>
    Effect.gen(function* () {
      const { adapter, sent } = yield* makeHarness("root");

      yield* runCommand(adapter, ALICE, PAIRWISE_COMMAND);
      const requests = yield* Queue.takeN(sent, 2);

      expect(new Set([...requests].map((input) => input.to))).toEqual(
        new Set([ALICE, BOB]),
      );
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
        contribution: { id: "gather-7" },
        message: "Monday works.",
      });

      yield* runCommand(adapter, ROOT, text);

      expect(yield* Queue.take(sent)).toEqual({
        to: ROOT,
        content: contributionContent("gather-7", "Monday works."),
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
        const requests = yield* Queue.takeN(sent, 2);
        const id = gatherIdOf([...requests][0] as SendInput);

        yield* adapter.onDelivery(
          direct(ALICE, contributionContent(id, "Mon")),
        );
        yield* adapter.onDelivery(direct(BOB, contributionContent(id, "Tue")));
        const turn = yield* Queue.take(turns);

        expect(textOf(turn)).toContain("- agent:alice: Mon");
        expect(textOf(turn)).toContain("- agent:bob: Tue");
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

        expect(textOf(turn)).toContain(
          "No answer from: agent:alice, agent:bob.",
        );
      }),
  );
});

describe("gather adapter at a shared-gather member", () => {
  const request = {
    members: [ALICE, BOB],
    prompt: "When can you meet?",
    deadlineAt: DEADLINE_SECONDS * 1_000,
    topology: "shared",
  } as const;

  it.scoped("hands the request to the model", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness("bob");

      const disposition = yield* adapter.onDelivery(
        group(ROOT, requestContent("gather-9", request, GROUP)),
      );

      expect(disposition).toBe("passthrough");
    }),
  );

  it.scoped("withholds a peer's contribution from the model", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness("bob");
      yield* adapter.onDelivery(
        group(ROOT, requestContent("gather-9", request, GROUP)),
      );

      const disposition = yield* adapter.onDelivery(
        group(ALICE, contributionContent("gather-9", "Mon")),
      );

      expect(disposition).toBe("consumed");
    }),
  );

  it.scoped(
    "runs one turn with the agreed answers when the close record arrives",
    () =>
      Effect.gen(function* () {
        const { adapter, turns } = yield* makeHarness("bob");
        yield* adapter.onDelivery(
          group(ROOT, requestContent("gather-9", request, GROUP)),
        );
        yield* adapter.onDelivery(
          group(ALICE, contributionContent("gather-9", "Mon")),
        );

        yield* adapter.onDelivery(
          group(ROOT, closeContent("gather-9", [ALICE])),
        );
        const turn = yield* Queue.take(turns);

        expect(textOf(turn)).toContain("- agent:alice: Mon");
      }),
  );
});
