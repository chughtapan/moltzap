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

const Society = Simulator.define(
  "moltzap.mixed-runtime-e2e/v1",
  EvaluationEvents,
);
const customerRuntimeDelegate = effectRuntime({
  onMessage: (context) => Effect.succeed(`customer:${context.agent.name}`),
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
    onMessage: (context) => Effect.succeed(`effect:${context.agent.name}`),
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
): Effect.Effect<
  ReadonlyArray<EpisodeResponse>,
  NetworkFailure | AgentResponseTimedOut,
  Network | Scope.Scope
> {
  return directEpisode(
    target,
    `Hello ${target.name}. Reply with one brief, non-empty greeting.`,
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
    const responses = yield* Effect.forEach(
      [started.openclaw, started.nanoclaw, started.effect, started.customer],
      probe,
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

function namesOf(
  events: ReadonlyArray<{ readonly agentName: string }>,
): ReadonlyArray<string> {
  return [...new Set(events.map((event) => event.agentName))].sort();
}

function nonEmptyResponse(
  selected: EvaluationResponseSelected,
  received: ReadonlyArray<EndpointMessageReceived>,
): boolean {
  const message = received.find(
    (event) =>
      event.messageId === selected.messageId &&
      event.senderId === selected.targetId &&
      event.endpointId === selected.endpointId,
  );
  return (
    message !== undefined &&
    message.parts.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    )
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
  const expectedNames = ["customer", "effect", "nanoclaw", "openclaw"];
  const ready = Chunk.toReadonlyArray(evidence.ready);
  const received = Chunk.toReadonlyArray(evidence.received);
  const selected = Chunk.toReadonlyArray(evidence.selected);
  const terminal = [
    ...Chunk.toReadonlyArray(evidence.processExited),
    ...Chunk.toReadonlyArray(evidence.processSignaled),
    ...Chunk.toReadonlyArray(evidence.runtimeCompleted),
    ...Chunk.toReadonlyArray(evidence.runtimeFailed),
  ];
  const committedIds = new Set(
    Chunk.toReadonlyArray(evidence.router).map((event) => event.messageId),
  );

  assert.deepStrictEqual(namesOf(ready), expectedNames);
  assert.lengthOf(selected, expectedNames.length);
  assert.isTrue(
    selected.every((selection) => nonEmptyResponse(selection, received)),
  );
  assert.isTrue(
    selected.every((selection) => committedIds.has(selection.messageId)),
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
