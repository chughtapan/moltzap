/**
 * @file Gated mixed-runtime proof over one production router and ledger.
 *
 * Gate with `MOLTZAP_AGENT_EVAL_ITEST=1`. Optional model overrides are read
 * from `MOLTZAP_OPENCLAW_EVAL_MODEL` and `MOLTZAP_NANOCLAW_EVAL_MODEL`.
 */
import { assert, it } from "@effect/vitest";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  AgentRuntimeReady,
  EndpointMessageReceived,
  ProgramSucceeded,
  RouterMessageCommitted,
  Simulator,
  defineRuntime,
  effectRuntime,
  nanoclawRuntime,
  openClawRuntime,
  simulatorLayer,
  type AgentHandle,
  type Network,
  type NetworkFailure,
} from "@moltzap/simulator";
import type { CompletedRunLedger } from "@moltzap/simulator/ledger";
import {
  Cause,
  Chunk,
  Config,
  Duration,
  Effect,
  Exit,
  Schema,
  type Scope,
  Stream,
} from "effect";
import {
  EvaluationEvents,
  EvaluationResponseSelected,
  selectEvaluationResponse,
} from "./evaluation-events.js";
import { directEpisode, type EpisodeResponse } from "./episodes.js";

const INTEGRATION_ENABLED = Effect.runSync(
  Config.string("MOLTZAP_AGENT_EVAL_ITEST").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
);
const OPENCLAW_MODEL = optionalConfig("MOLTZAP_OPENCLAW_EVAL_MODEL");
const NANOCLAW_MODEL = optionalConfig("MOLTZAP_NANOCLAW_EVAL_MODEL");
const RUNTIME_STARTUP_TIMEOUT = Duration.minutes(5);
const ROUTER_STARTUP_TIMEOUT = Duration.minutes(10);
const RESPONSE_TIMEOUT = Duration.minutes(10);
const RUN_TIMEOUT = Duration.minutes(40);
const TEST_RUNNER_MARGIN_MS = 5 * 60_000;
const LEDGER_ROOT = "../../eval-results";
const SCENARIO_ID = "MIXED-RUNTIME-E2E";
const RUNTIME_PROBES = Object.freeze({
  openclaw: {
    runtime: "openclaw",
    response: "MOLTZAP_OPENCLAW_E2E_OK_9F2C",
  },
  nanoclaw: {
    runtime: "nanoclaw",
    response: "MOLTZAP_NANOCLAW_E2E_OK_7B4D",
  },
  effect: {
    runtime: "effect",
    response: "MOLTZAP_EFFECT_E2E_OK_5A8E",
  },
  customer: {
    runtime: "customer-defined",
    response: "MOLTZAP_CUSTOM_E2E_OK_3C6F",
  },
});

const Society = Simulator.define(
  "moltzap.mixed-runtime-e2e/v2",
  EvaluationEvents,
);
const customerRuntimeDelegate = effectRuntime({
  onMessage: () => Effect.succeed(RUNTIME_PROBES.customer.response),
});
const customerDefinedRuntime = defineRuntime({
  name: "customer-defined",
  acquire: (input) => customerRuntimeDelegate.acquire(input),
});
const agents = Society.agents({
  openclaw: openClawRuntime({
    installMode: "workspace",
    startupTimeout: RUNTIME_STARTUP_TIMEOUT,
    ...(OPENCLAW_MODEL === undefined ? {} : { modelId: OPENCLAW_MODEL }),
  }),
  nanoclaw: nanoclawRuntime({
    installMode: "workspace",
    autoRegisterConversations: true,
    startupTimeout: RUNTIME_STARTUP_TIMEOUT,
    ...(NANOCLAW_MODEL === undefined ? {} : { modelId: NANOCLAW_MODEL }),
  }),
  effect: effectRuntime({
    onMessage: () => Effect.succeed(RUNTIME_PROBES.effect.response),
  }),
  customer: customerDefinedRuntime,
});

class AgentResponseTimedOut extends Schema.TaggedError<AgentResponseTimedOut>()(
  "AgentResponseTimedOut",
  {
    agent: Schema.NonEmptyString,
    timeout: Schema.NonEmptyString,
  },
) {}

function optionalConfig(name: string): string | undefined {
  const value = Effect.runSync(
    Config.string(name).pipe(Config.withDefault("")),
  ).trim();
  return value.length === 0 ? undefined : value;
}

function probe(
  target: AgentHandle,
  expectedResponse: string,
): Effect.Effect<
  ReadonlyArray<EpisodeResponse>,
  NetworkFailure | AgentResponseTimedOut,
  Network | Scope.Scope
> {
  return directEpisode(
    target,
    `Reply with exactly this token and no other text or attachments: ${expectedResponse}`,
  ).pipe(
    Effect.timeoutFail({
      duration: RESPONSE_TIMEOUT,
      onTimeout: () =>
        AgentResponseTimedOut.make({
          agent: target.name,
          timeout: Duration.format(RESPONSE_TIMEOUT),
        }),
    }),
  );
}

function mixedProgram() {
  return Effect.gen(function* () {
    const started = yield* agents.Agents;
    const probes = [
      {
        target: started.openclaw,
        expectedResponse: RUNTIME_PROBES.openclaw.response,
      },
      {
        target: started.nanoclaw,
        expectedResponse: RUNTIME_PROBES.nanoclaw.response,
      },
      {
        target: started.effect,
        expectedResponse: RUNTIME_PROBES.effect.response,
      },
      {
        target: started.customer,
        expectedResponse: RUNTIME_PROBES.customer.response,
      },
    ] as const;
    const responses = yield* Effect.forEach(
      probes,
      ({ target, expectedResponse }) => probe(target, expectedResponse),
      { concurrency: 1 },
    );
    const events = yield* Society.Events;
    yield* Effect.forEach(
      responses.flat(),
      (response) =>
        events.emit(selectEvaluationResponse(SCENARIO_ID, response)),
      { concurrency: 1, discard: true },
    );
  });
}

function probeResponseFor(agentName: string): string | undefined {
  return Object.entries(RUNTIME_PROBES).find(
    ([name]) => name === agentName,
  )?.[1].response;
}

function matchesProbe(
  selected: EvaluationResponseSelected,
  received: ReadonlyArray<EndpointMessageReceived>,
): boolean {
  const expected = probeResponseFor(selected.targetName);
  const message = received.find(
    (event) =>
      event.messageId === selected.messageId &&
      event.taskId === selected.taskId &&
      event.senderId === selected.targetId &&
      event.endpointId === selected.endpointId,
  );
  if (
    expected === undefined ||
    message === undefined ||
    message.parts.length !== 1
  ) {
    return false;
  }
  const [part] = message.parts;
  return part.type === "text" && part.text.trim() === expected;
}

function matchesRouterCommit(
  selected: EvaluationResponseSelected,
  committed: ReadonlyArray<RouterMessageCommitted>,
): boolean {
  return committed.some(
    (event) =>
      event.messageId === selected.messageId &&
      event.taskId === selected.taskId &&
      event.senderId === selected.targetId,
  );
}

function collectProofEvidence(
  ledger: CompletedRunLedger<typeof Society.catalog>,
) {
  return Effect.all({
    ready: Stream.runCollect(ledger.events(AgentRuntimeReady)),
    received: Stream.runCollect(ledger.events(EndpointMessageReceived)),
    selected: Stream.runCollect(ledger.events(EvaluationResponseSelected)),
    succeeded: Stream.runCollect(ledger.events(ProgramSucceeded)),
    router: Stream.runCollect(ledger.events(RouterMessageCommitted)),
    processExited: Stream.runCollect(ledger.events(AgentProcessExited)),
    processSignaled: Stream.runCollect(ledger.events(AgentProcessSignaled)),
    runtimeCompleted: Stream.runCollect(ledger.events(AgentRuntimeCompleted)),
    runtimeFailed: Stream.runCollect(ledger.events(AgentRuntimeFailed)),
  });
}

type ProofEvidence = Effect.Effect.Success<
  ReturnType<typeof collectProofEvidence>
>;

function assertProofEvidence(evidence: ProofEvidence): void {
  const ready = Chunk.toReadonlyArray(evidence.ready);
  const received = Chunk.toReadonlyArray(evidence.received);
  const selected = Chunk.toReadonlyArray(evidence.selected);
  const committed = Chunk.toReadonlyArray(evidence.router);
  const terminal = [
    ...Chunk.toReadonlyArray(evidence.processExited),
    ...Chunk.toReadonlyArray(evidence.processSignaled),
    ...Chunk.toReadonlyArray(evidence.runtimeCompleted),
    ...Chunk.toReadonlyArray(evidence.runtimeFailed),
  ];

  assert.deepStrictEqual(
    ready
      .map((event) => [String(event.agentName), event.runtime] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    Object.entries(RUNTIME_PROBES)
      .map(([name, probe]) => [name, probe.runtime] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.lengthOf(selected, Object.keys(RUNTIME_PROBES).length);
  assert.isTrue(
    selected.every((selection) => matchesProbe(selection, received)),
  );
  assert.isTrue(
    selected.every((selection) => matchesRouterCommit(selection, committed)),
  );
  assert.strictEqual(Chunk.size(evidence.succeeded), 1);
  assert.lengthOf(
    terminal,
    0,
    "every runtime must remain connected until the customer program completes",
  );
}

const architectureProof = Effect.fn("evals.mixedRuntimeProof")(function* () {
  const run = yield* Society.run(agents, mixedProgram(), {
    provenance: {
      evaluation: SCENARIO_ID,
      condition: "production-mixed-runtime",
    },
  });
  assert.isTrue(
    Exit.isSuccess(run.exit),
    Exit.isFailure(run.exit)
      ? `mixed runtime program failed:\n${Cause.pretty(run.exit.cause)}`
      : undefined,
  );

  const ledger = yield* Society.openLedger(run.ledger);
  assertProofEvidence(yield* collectProofEvidence(ledger));
});

const PlatformLayer = simulatorLayer({
  ledgerDirectory: LEDGER_ROOT,
  router: { startupTimeout: ROUTER_STARTUP_TIMEOUT },
});

it.scopedLive.skipIf(!INTEGRATION_ENABLED)(
  "runs OpenClaw, NanoClaw, built-in code, and customer-defined agents together",
  () =>
    architectureProof().pipe(
      Effect.provide(PlatformLayer),
      Effect.timeoutFail({
        duration: RUN_TIMEOUT,
        onTimeout: () =>
          new Error(
            `mixed runtime proof did not complete within ${Duration.format(RUN_TIMEOUT)}`,
          ),
      }),
    ),
  Duration.toMillis(RUN_TIMEOUT) + TEST_RUNNER_MARGIN_MS,
);
