/**
 * @file Gather overlay spike against real daemons, a real Registry, and a real Router.
 *
 * Each scenario registers a fresh set of agents, so a "cold" scenario's gather
 * request is the first post its conversations ever carry (GENESIS, unanimous)
 * and a "warm" scenario exchanges one ordinary post first (later posts need
 * only the POST quorum). Group size G counts the initiator: G=3 has no fault
 * tolerance, G=5 tolerates one silent signer.
 *
 * Every scenario appends its observed outcome to a results file so the spike
 * verdict quotes measurements rather than pass/fail marks.
 */

import { Duration, Effect, Exit, Option, Schema, Scope, Stream } from "effect";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  contributionContent,
  type GatherOverlay,
  type GatherResult,
  type GatherTopology,
  makeGatherOverlay,
  type ObservedGatherRequest,
} from "../../openclaw-channel/src/gather-overlay.js";
import {
  acquireHarnessEndpoint,
  AgentAddress,
  type Content,
  type HarnessEndpoint,
  MessageAddressInput,
} from "../src/index.js";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  type ProcessInfrastructure,
  type RunningProcess,
  stopProcess,
} from "./daemon-process-harness.js";

const WORKSPACE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const RESULTS_FILE = join(
  WORKSPACE_ROOT,
  ".scratch/gather-spike-results.jsonl",
);
const REVISION = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: WORKSPACE_ROOT,
  encoding: "utf8",
}).trim();

const GATHER_WINDOW = Duration.seconds(12);
const CLOSE_WAIT_MILLIS = 5_000;
const MEMBER_RESULT_WAIT = Duration.seconds(8);
const LIVENESS_WAIT = Duration.seconds(10);
const HONEST_REPLY_DELAY = Duration.seconds(2);
const LATE_MARGIN_MILLIS = 300;
const SCENARIO_TIMEOUT_MILLIS = 240_000;

const warmupContent = [
  { type: "text", text: "warm-up post" },
] as const satisfies Content;
const livenessContent = [
  { type: "text", text: "post-gather liveness probe" },
] as const satisfies Content;

type Fault =
  | "none"
  | "silent"
  | "down-before-request"
  | "down-mid-collection"
  | "duplicate"
  | "late-contribution";

interface Scenario {
  readonly label: string;
  readonly topology: GatherTopology;
  readonly groupSize: 3 | 5;
  readonly warm: boolean;
  readonly fault: Fault;
  readonly concurrentGathers?: 2;
}

interface Participant {
  readonly address: AgentAddress;
  readonly endpoint: HarnessEndpoint;
  readonly overlay: GatherOverlay;
  readonly daemon: RunningProcess;
}

interface Outcome {
  readonly missingCount: number;
  readonly agreeingViews: number;
  readonly resultlessViews: number;
  readonly secondGatherMissing: number;
  readonly contributed: readonly string[];
  readonly missing: readonly string[];
  readonly closeCertified: boolean;
  readonly elapsedMillis: number;
  readonly memberViews: readonly (readonly string[] | "no-result")[];
  readonly liveAfter: boolean;
}

let scenarioCounter = 0;
let infrastructureScope: Scope.CloseableScope | undefined;
let infrastructure: ProcessInfrastructure | undefined;

beforeAll(async () => {
  infrastructureScope = await Effect.runPromise(Scope.make());
  infrastructure = await Effect.runPromise(
    Scope.extend(acquireProcessInfrastructure, infrastructureScope),
  );
  mkdirSync(dirname(RESULTS_FILE), { recursive: true });
}, 120_000);

afterAll(async () => {
  if (infrastructureScope !== undefined) {
    await Effect.runPromise(Scope.close(infrastructureScope, Exit.void));
  }
}, 60_000);

function addressOf(fixture: DaemonProcessFixture): AgentAddress {
  return Schema.decodeUnknownSync(AgentAddress)(`agent:${fixture.agentName}`);
}

const register = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      yield* management.register(makeRegistrationRequest(fixture));
    }),
  );

/**
 * The faulty peer is always the last contributor. Honest contributors wait
 * briefly before answering so a peer that goes down on seeing the request is
 * gone before their contributions need its signature.
 */
function responder(
  scenario: Scenario,
  isFaulty: boolean,
  actions: {
    readonly stopSelf: Effect.Effect<void>;
    readonly sendExtra: (request: ObservedGatherRequest) => Effect.Effect<void>;
  },
): (request: ObservedGatherRequest) => Effect.Effect<Option.Option<string>> {
  return (request) => {
    const honest = Effect.succeed(Option.some(`answer to ${request.id}`)).pipe(
      Effect.delay(HONEST_REPLY_DELAY),
    );
    if (!isFaulty) {
      return honest;
    }
    switch (scenario.fault) {
      case "silent":
        return Effect.succeed(Option.none());
      case "down-mid-collection":
        return actions.stopSelf.pipe(Effect.as(Option.none()));
      case "duplicate":
        return honest.pipe(Effect.tap(() => actions.sendExtra(request)));
      case "late-contribution":
        return Effect.succeed(Option.some("answer at the deadline")).pipe(
          Effect.delay(
            Duration.millis(
              Math.max(request.deadlineAt - LATE_MARGIN_MILLIS - Date.now(), 0),
            ),
          ),
        );
      default:
        return honest;
    }
  };
}

const startParticipant = (
  scenario: Scenario,
  fixture: DaemonProcessFixture,
  isFaulty: boolean,
) =>
  Effect.gen(function* () {
    const daemon = yield* acquireDaemonProcess(fixture);
    yield* register(fixture);
    const endpoint = yield* acquireHarnessEndpoint(fixture.endpoint);
    const overlay = yield* makeGatherOverlay({
      self: addressOf(fixture),
      send: endpoint.send,
      closeWaitMillis: CLOSE_WAIT_MILLIS,
      respond: responder(scenario, isFaulty, {
        stopSelf: stopProcess(daemon),
        sendExtra: (request) =>
          endpoint
            .send({
              to: request.replyTo,
              content: contributionContent(request.id, "second answer"),
            })
            .pipe(Effect.ignore),
      }),
    });
    yield* Stream.runForEach(endpoint.messages, (delivery) =>
      overlay
        .onDelivery(delivery)
        .pipe(
          Effect.flatMap((disposition) =>
            disposition === "passthrough"
              ? Effect.ignore(delivery.acknowledge)
              : Effect.void,
          ),
        ),
    ).pipe(Effect.ignore, Effect.forkScoped);
    const participant: Participant = {
      address: addressOf(fixture),
      endpoint,
      overlay,
      daemon,
    };
    return participant;
  });

function conversationAddresses(
  scenario: Scenario,
  root: Participant,
  contributors: readonly Participant[],
): readonly string[] {
  if (scenario.topology === "pairwise") {
    return contributors.map((contributor) => contributor.address);
  }
  const names = [root, ...contributors]
    .map((participant) => participant.address.slice("agent:".length))
    .sort((left, right) => (left < right ? -1 : 1));
  return [`group:${names.join(",")}`];
}

const postToAll = (
  root: Participant,
  addresses: readonly string[],
  content: Content,
  wait: Duration.Duration,
) =>
  Effect.forEach(
    addresses,
    (address) =>
      root.endpoint
        .send({
          to: Schema.decodeUnknownSync(MessageAddressInput)(address),
          content,
        })
        .pipe(
          Effect.as(true),
          Effect.timeoutTo({
            duration: wait,
            onSuccess: (certified) => certified,
            onTimeout: () => false,
          }),
          Effect.catchAll(() => Effect.succeed(false)),
        ),
    { concurrency: "unbounded" },
  );

const memberView = (participant: Participant, result: GatherResult) =>
  participant.overlay.awaitMemberResult(result.id).pipe(
    Effect.map((view) => [...view.keys()].sort()),
    Effect.timeoutTo({
      duration: MEMBER_RESULT_WAIT,
      onSuccess: (view): readonly string[] | "no-result" => view,
      onTimeout: (): readonly string[] | "no-result" => "no-result",
    }),
  );

const runScenario = (scenario: Scenario): Effect.Effect<Outcome, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const shared = infrastructure;
      if (shared === undefined) {
        return yield* Effect.fail("infrastructure did not start");
      }
      scenarioCounter += 1;
      const prefix = `g${scenarioCounter}`;
      const fixtures = yield* Effect.forEach(
        Array.from({ length: scenario.groupSize }, (unused, index) => index),
        (index) =>
          makeDaemonProcessFixture(
            shared,
            index === 0 ? `${prefix}-root` : `${prefix}-peer${index}`,
          ),
      );
      const participants = yield* Effect.forEach(
        fixtures,
        (fixture, index) =>
          startParticipant(scenario, fixture, index === fixtures.length - 1),
        { concurrency: "unbounded" },
      );
      const [root, ...contributors] = participants;
      if (root === undefined) {
        return yield* Effect.fail("no initiator");
      }
      const faulty = contributors[contributors.length - 1];
      const addresses = conversationAddresses(scenario, root, contributors);
      if (scenario.warm) {
        yield* postToAll(root, addresses, warmupContent, Duration.seconds(60));
      }
      if (scenario.fault === "down-before-request" && faulty !== undefined) {
        yield* stopProcess(faulty.daemon);
      }

      const startedAt = Date.now();
      const request = {
        members: contributors.map((contributor) => contributor.address),
        prompt: "When can you meet?",
        deadlineAt: Date.now() + Duration.toMillis(GATHER_WINDOW),
        topology: scenario.topology,
      };
      const [result, second] = yield* Effect.all(
        [
          root.overlay.gather(request),
          scenario.concurrentGathers === 2
            ? root.overlay.gather(request)
            : Effect.succeed(undefined),
        ] as const,
        { concurrency: 2 },
      );
      const elapsedMillis = Date.now() - startedAt;

      const honest = contributors.filter(
        (contributor) =>
          contributor !== faulty ||
          scenario.fault === "none" ||
          scenario.fault === "duplicate" ||
          scenario.fault === "late-contribution" ||
          scenario.fault === "silent",
      );
      const memberViews =
        scenario.topology === "shared"
          ? yield* Effect.forEach(
              honest,
              (contributor) => memberView(contributor, result),
              { concurrency: "unbounded" },
            )
          : [];
      const live = yield* postToAll(
        root,
        addresses,
        livenessContent,
        LIVENESS_WAIT,
      );
      const contributed = [...result.contributions.keys()].sort();
      return {
        missingCount: result.missing.length,
        agreeingViews: memberViews.filter(
          (view) =>
            view !== "no-result" &&
            JSON.stringify(view) === JSON.stringify(contributed),
        ).length,
        resultlessViews: memberViews.filter((view) => view === "no-result")
          .length,
        secondGatherMissing: second === undefined ? 0 : second.missing.length,
        contributed,
        missing: [...result.missing].sort(),
        closeCertified: result.closeCertified,
        elapsedMillis,
        memberViews,
        liveAfter: live.every((certified) => certified),
      };
    }),
  );

async function observe(scenario: Scenario): Promise<Outcome> {
  const outcome = await Effect.runPromise(runScenario(scenario));
  appendFileSync(
    RESULTS_FILE,
    `${JSON.stringify({ revision: REVISION, at: new Date().toISOString(), scenario, outcome })}\n`,
  );
  return outcome;
}

const PAIRWISE_TEMPERATURES = [
  { warm: false, temperature: "cold" },
  { warm: true, temperature: "warm" },
] as const;
const GROUP_SIZES = [3, 5] as const;

/**
 * A pairwise fault is confined to the faulty peer's own conversation, so every
 * expectation is "exactly the faulty member is missing", cold or warm.
 */
describe.each(PAIRWISE_TEMPERATURES)(
  "pairwise gather on $temperature conversations",
  ({ warm, temperature }) => {
    describe.each(GROUP_SIZES)("G=%i", (groupSize) => {
      const base = { topology: "pairwise", groupSize, warm } as const;
      const label = (fault: string) =>
        `pairwise ${fault} ${temperature} G${groupSize}`;

      it(
        "collects every contribution when all peers answer",
        async () => {
          const outcome = await observe({
            ...base,
            label: label("honest"),
            fault: "none",
          });
          expect(outcome).toMatchObject({ missingCount: 0, liveAfter: true });
        },
        SCENARIO_TIMEOUT_MILLIS,
      );

      it(
        "names only the silent peer as missing",
        async () => {
          const outcome = await observe({
            ...base,
            label: label("silent"),
            fault: "silent",
          });
          expect(outcome).toMatchObject({ missingCount: 1, liveAfter: true });
        },
        SCENARIO_TIMEOUT_MILLIS,
      );

      it(
        "names only the peer that was down before the request",
        async () => {
          const outcome = await observe({
            ...base,
            label: label("down-before"),
            fault: "down-before-request",
          });
          expect(outcome).toMatchObject({ missingCount: 1, liveAfter: false });
        },
        SCENARIO_TIMEOUT_MILLIS,
      );

      it(
        "names only the peer that went down during collection",
        async () => {
          const outcome = await observe({
            ...base,
            label: label("down-mid"),
            fault: "down-mid-collection",
          });
          expect(outcome).toMatchObject({ missingCount: 1 });
        },
        SCENARIO_TIMEOUT_MILLIS,
      );

      it(
        "keeps one contribution from a peer that answers twice",
        async () => {
          const outcome = await observe({
            ...base,
            label: label("duplicate"),
            fault: "duplicate",
          });
          expect(outcome).toMatchObject({ missingCount: 0 });
        },
        SCENARIO_TIMEOUT_MILLIS,
      );
    });
  },
);

describe("pairwise gather, two at once", () => {
  it(
    "completes two concurrent gathers to the same peers",
    async () => {
      const outcome = await observe({
        label: "pairwise concurrent warm G3",
        topology: "pairwise",
        groupSize: 3,
        warm: true,
        fault: "none",
        concurrentGathers: 2,
      });
      expect(outcome).toMatchObject({
        missingCount: 0,
        secondGatherMissing: 0,
      });
    },
    SCENARIO_TIMEOUT_MILLIS,
  );
});

describe("shared gather with every signer up", () => {
  describe.each(PAIRWISE_TEMPERATURES)(
    "$temperature group",
    ({ warm, temperature }) => {
      describe.each(GROUP_SIZES)("G=%i", (groupSize) => {
        const base = { topology: "shared", groupSize, warm } as const;
        const label = (fault: string) =>
          `shared ${fault} ${temperature} G${groupSize}`;

        it(
          "closes with every member holding the same full result",
          async () => {
            const outcome = await observe({
              ...base,
              label: label("honest"),
              fault: "none",
            });
            expect(outcome).toMatchObject({
              missingCount: 0,
              closeCertified: true,
              agreeingViews: groupSize - 1,
            });
          },
          SCENARIO_TIMEOUT_MILLIS,
        );

        it(
          "closes with every member agreeing the silent peer is missing",
          async () => {
            const outcome = await observe({
              ...base,
              label: label("silent"),
              fault: "silent",
            });
            expect(outcome).toMatchObject({
              missingCount: 1,
              closeCertified: true,
              agreeingViews: groupSize - 1,
            });
          },
          SCENARIO_TIMEOUT_MILLIS,
        );

        it(
          "keeps one contribution from a peer that answers twice",
          async () => {
            const outcome = await observe({
              ...base,
              label: label("duplicate"),
              fault: "duplicate",
            });
            expect(outcome).toMatchObject({
              missingCount: 0,
              agreeingViews: groupSize - 1,
            });
          },
          SCENARIO_TIMEOUT_MILLIS,
        );

        it(
          "has every member place a deadline-racing contribution on the same side of the close",
          async () => {
            const outcome = await observe({
              ...base,
              label: label("late"),
              fault: "late-contribution",
            });
            expect(outcome).toMatchObject({
              closeCertified: true,
              agreeingViews: groupSize - 1,
            });
          },
          SCENARIO_TIMEOUT_MILLIS,
        );
      });
    },
  );
});

describe("shared gather with one signer down before the request", () => {
  it(
    "lands no request on a cold G=3 group, whose GENESIS is unanimous",
    async () => {
      const outcome = await observe({
        label: "shared down-before cold G3",
        topology: "shared",
        groupSize: 3,
        warm: false,
        fault: "down-before-request",
      });
      expect(outcome).toMatchObject({ missingCount: 2, closeCertified: false });
    },
    SCENARIO_TIMEOUT_MILLIS,
  );

  it(
    "lands no request on a cold G=5 group, whose GENESIS is unanimous",
    async () => {
      const outcome = await observe({
        label: "shared down-before cold G5",
        topology: "shared",
        groupSize: 5,
        warm: false,
        fault: "down-before-request",
      });
      expect(outcome).toMatchObject({ missingCount: 4, closeCertified: false });
    },
    SCENARIO_TIMEOUT_MILLIS,
  );

  it(
    "lands no request on a warm G=3 group, which needs all three signers",
    async () => {
      const outcome = await observe({
        label: "shared down-before warm G3",
        topology: "shared",
        groupSize: 3,
        warm: true,
        fault: "down-before-request",
      });
      expect(outcome).toMatchObject({ missingCount: 2, closeCertified: false });
    },
    SCENARIO_TIMEOUT_MILLIS,
  );

  it(
    "completes without the down peer on a warm G=5 group, which needs four of five",
    async () => {
      const outcome = await observe({
        label: "shared down-before warm G5",
        topology: "shared",
        groupSize: 5,
        warm: true,
        fault: "down-before-request",
      });
      expect(outcome).toMatchObject({ missingCount: 1, closeCertified: true });
    },
    SCENARIO_TIMEOUT_MILLIS,
  );
});

describe("shared gather with one signer down during collection", () => {
  it(
    "stalls a cold G=3 group before its close can certify",
    async () => {
      const outcome = await observe({
        label: "shared down-mid cold G3",
        topology: "shared",
        groupSize: 3,
        warm: false,
        fault: "down-mid-collection",
      });
      expect(outcome).toMatchObject({
        closeCertified: false,
        liveAfter: false,
      });
    },
    SCENARIO_TIMEOUT_MILLIS,
  );

  it(
    "stalls a warm G=3 group before its close can certify",
    async () => {
      const outcome = await observe({
        label: "shared down-mid warm G3",
        topology: "shared",
        groupSize: 3,
        warm: true,
        fault: "down-mid-collection",
      });
      expect(outcome).toMatchObject({
        closeCertified: false,
        liveAfter: false,
      });
    },
    SCENARIO_TIMEOUT_MILLIS,
  );

  it(
    "completes a cold G=5 group without the peer that went down",
    async () => {
      const outcome = await observe({
        label: "shared down-mid cold G5",
        topology: "shared",
        groupSize: 5,
        warm: false,
        fault: "down-mid-collection",
      });
      expect(outcome).toMatchObject({
        missingCount: 1,
        closeCertified: true,
        liveAfter: true,
      });
    },
    SCENARIO_TIMEOUT_MILLIS,
  );

  it(
    "completes a warm G=5 group without the peer that went down",
    async () => {
      const outcome = await observe({
        label: "shared down-mid warm G5",
        topology: "shared",
        groupSize: 5,
        warm: true,
        fault: "down-mid-collection",
      });
      expect(outcome).toMatchObject({
        missingCount: 1,
        closeCertified: true,
        liveAfter: true,
      });
    },
    SCENARIO_TIMEOUT_MILLIS,
  );
});
