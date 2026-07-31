/**
 * @file Opt-in mixed-roster measurement over one production router and ledger.
 *
 * Enable with `MOLTZAP_AGENT_EVAL_ITEST=1`. Optional model overrides are read
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
  simulator,
  defineRuntime,
  effectRuntime,
  nanoclawRuntime,
  openClawRuntime,
  simulatorLayer,
  type AgentHandle,
} from "@moltzap/simulator";
import type { CompletedRunLedger } from "@moltzap/simulator/ledger";
import { Chunk, Config, Duration, Effect, Exit, Stream } from "effect";
import {
  evaluationEvents,
  EvaluationResponseSelected,
  selectEvaluationResponse,
} from "./evaluation-events.js";
import { directEpisode } from "./episodes.js";

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
const MEASUREMENT_ID = "MIXED-ROSTER";
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

const society = simulator.define(
  "moltzap.mixed-runtime-e2e/v2",
  evaluationEvents,
);
const customerRuntimeDelegate = effectRuntime({
  onMessage: () => Effect.succeed(RUNTIME_PROBES.customer.response),
});
const customerDefinedRuntime = defineRuntime({
  name: "customer-defined",
  acquire: (input) => customerRuntimeDelegate.acquire(input),
});
const agents = society.agents({
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

function optionalConfig(name: string): string | undefined {
  const value = Effect.runSync(
    Config.string(name).pipe(Config.withDefault("")),
  ).trim();
  return value.length === 0 ? undefined : value;
}

function probe(target: AgentHandle, expectedResponse: string) {
  return directEpisode(
    target,
    `Reply with exactly this token and no other text or attachments: ${expectedResponse}`,
  ).pipe(Effect.timeout(RESPONSE_TIMEOUT));
}

function mixedProgram() {
  return Effect.gen(function* () {
    const started = yield* agents.startedAgents;
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
    const events = yield* society.events;
    yield* Effect.forEach(
      responses.flat(),
      (response) =>
        events.emit(selectEvaluationResponse(MEASUREMENT_ID, response)),
      { concurrency: 1, discard: true },
    );
    return undefined;
  });
}

function probeResponseFor(agentName: string): string | undefined {
  return Object.entries(RUNTIME_PROBES).find(
    ([name]) => name === agentName,
  )?.[1].response;
}

function matchesProbe(
  selected: EvaluationResponseSelected,
  received: readonly EndpointMessageReceived[],
): boolean {
  const expected = probeResponseFor(selected.targetName);
  const message = received.find(
    (event) =>
      event.messageId === selected.messageId &&
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
  committed: readonly RouterMessageCommitted[],
): boolean {
  return committed.some(
    (event) =>
      event.messageId === selected.messageId &&
      event.senderId === selected.targetId,
  );
}

function collectMeasurementEvidence(
  ledger: CompletedRunLedger<typeof society.catalog>,
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

type MeasurementEvidence = Effect.Effect.Success<
  ReturnType<typeof collectMeasurementEvidence>
>;

function assertMeasurementEvidence(evidence: MeasurementEvidence): void {
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

const mixedRosterMeasurement = Effect.fn("evals.measureMixedRoster")(
  function* () {
    const run = yield* society.run(agents, mixedProgram(), {
      provenance: {
        evaluation: MEASUREMENT_ID,
        condition: "production-mixed-runtime",
      },
    });
    if (Exit.isFailure(run.exit)) {
      return yield* Effect.failCause(run.exit.cause);
    }

    const ledger = yield* society.openLedger(run.ledger);
    assertMeasurementEvidence(yield* collectMeasurementEvidence(ledger));
  },
);

const platformLayer = simulatorLayer({
  ledgerDirectory: LEDGER_ROOT,
  router: { startupTimeout: ROUTER_STARTUP_TIMEOUT },
});

it.scopedLive.skipIf(!INTEGRATION_ENABLED)(
  "runs OpenClaw, NanoClaw, built-in code, and customer-defined agents together",
  () =>
    mixedRosterMeasurement().pipe(
      Effect.provide(platformLayer),
      Effect.timeout(RUN_TIMEOUT),
    ),
  Duration.toMillis(RUN_TIMEOUT) + TEST_RUNNER_MARGIN_MS,
);
