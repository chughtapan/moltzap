/** @file Concrete mixed-agent conditions and code-defined case execution. */

import type { FileSystem, HttpClient, Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { agentName } from "@moltzap/protocol/identity";
import {
  CompletedLedgerReceipt,
  LedgerReceipt,
  ProgramFinished,
  simulator,
} from "@moltzap/simulator";
import {
  type AgentRuntime,
  type StartedAgent,
  nanoclawRuntime,
  openClawRuntime,
  runtimeConfigurationProjection,
  type NanoclawRuntimeOptions,
  type OpenClawRuntimeOptions,
} from "@moltzap/simulator/runtime";
import type {
  LedgerStorage,
  JsonValue,
  LedgerStorageError,
} from "@moltzap/simulator/ledger";
import type { RouterProvider } from "@moltzap/simulator/network";
import {
  Array as Arr,
  Cause,
  Duration,
  Effect,
  Exit,
  Option,
  Schema,
} from "effect";
import {
  TARGET_AGENT_NAME,
  type EvaluationCaseDefinition,
  type EvaluationCaseMetadata,
  type EvaluationCasePeer,
  type EvaluationCasePeers,
  type EvaluationCasePeerRuntimes,
  type EvaluationCaseProgramContext,
} from "./cases.js";
import {
  EvaluationEvidenceSelected,
  PeerExchangeNotObserved,
  evaluationEvents,
} from "./events.js";
import {
  decodeConditionId,
  decodeEvaluationEvidenceId,
  type ConditionId,
  type EvaluationCaseId,
  type EvaluationEvidenceId,
} from "./model.js";
import type {
  PeerExchange,
  EvaluationPeerGateway,
  EvaluationPeerObservation,
} from "./peer.js";
import {
  nanoclawPrincipalDriver,
  openClawPrincipalDriver,
  type EmitEvaluationEvent,
  type PrincipalDriver,
  type PrincipalDriverFactory,
} from "./principal.js";

type EvaluationExecutionRequirements =
  | CommandExecutor
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | LedgerStorage
  | RouterProvider;

const decodeAgentName = Schema.decodeSync(agentName);

/** Stable definition for every bundled behavioral case run. */
export const behavioralEvaluation = simulator.define(
  "moltzap.behavioral-evaluation/v1",
  evaluationEvents,
);

/** Customer-owned deadlines for observable behavior and complete case work. */
interface EvaluationExecutionPolicy {
  readonly peerObservationTimeout: Duration.Duration;
  readonly caseTimeout: Duration.Duration;
}

/** Stable identity supplied to native gateway calls and ledger provenance. */
interface EvaluationExecutionInput {
  readonly attemptId: string;
}

/** A case program could not complete with trustworthy evidence. */
export class EvaluationProgramFailed extends Schema.TaggedError<EvaluationProgramFailed>()(
  "EvaluationProgramFailed",
  {
    operation: Schema.Literal(
      "principal",
      "peer",
      "evidence",
      "runtime",
      "timeout",
    ),
    detail: Schema.NonEmptyString,
  },
) {}

/** A case program completed and its ledger completion is durable. */
class EvaluationExecutionCompleted extends Schema.TaggedClass<EvaluationExecutionCompleted>()(
  "EvaluationExecutionCompleted",
  {
    receipt: CompletedLedgerReceipt,
  },
) {}

/** Execution or infrastructure failed after ledger allocation. */
export class EvaluationExecutionFailed extends Schema.TaggedClass<EvaluationExecutionFailed>()(
  "EvaluationExecutionFailed",
  {
    receipt: LedgerReceipt,
    detail: Schema.NonEmptyString,
  },
) {}

/** Complete post-allocation result of one evaluation run. */
export type EvaluationExecutionResult =
  | EvaluationExecutionCompleted
  | EvaluationExecutionFailed;

/** Concrete condition with no runtime gateway union at its public boundary. */
export interface EvaluationCondition<
  RuntimeRequirements = EvaluationExecutionRequirements,
> {
  readonly id: ConditionId;
  readonly runtimeName: string;
  readonly runtimeConfiguration: JsonValue;
  readonly execute: <PeerRuntimes extends EvaluationCasePeerRuntimes>(
    definition: EvaluationCaseDefinition<PeerRuntimes>,
    input: EvaluationExecutionInput,
  ) => Effect.Effect<
    EvaluationExecutionResult,
    LedgerStorageError,
    EvaluationExecutionRequirements | RuntimeRequirements
  >;
}

/** Exact runtime and adapter captured behind one code-defined condition. */
export interface EvaluationConditionDefinition<
  Gateway,
  DriverFailure,
  RuntimeFailure,
  RuntimeRequirements,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
> {
  readonly id: ConditionId;
  readonly runtime: AgentRuntime<
    Gateway,
    RuntimeFailure,
    RuntimeRequirements,
    ConfigurationSchema
  >;
  readonly principal: PrincipalDriverFactory<Gateway, DriverFailure>;
  readonly execution: EvaluationExecutionPolicy;
}

interface OpenClawEvaluationConditionOptions {
  readonly runtime: Omit<OpenClawRuntimeOptions, "tools" | "sandbox">;
  readonly execution: EvaluationExecutionPolicy;
}

interface NanoclawEvaluationConditionOptions {
  readonly runtime: NanoclawRuntimeOptions;
  readonly execution: EvaluationExecutionPolicy;
}

const BUNDLED_OPENCLAW_TOOLS = {
  allow: ["message"],
  elevated: { enabled: false },
  exec: { mode: "deny" },
} satisfies NonNullable<OpenClawRuntimeOptions["tools"]>;

const BUNDLED_OPENCLAW_SANDBOX = {
  mode: "all",
  backend: "docker",
  scope: "session",
  workspaceAccess: "none",
  docker: { network: "none" },
} satisfies NonNullable<OpenClawRuntimeOptions["sandbox"]>;

Object.freeze(BUNDLED_OPENCLAW_TOOLS.allow);
Object.freeze(BUNDLED_OPENCLAW_TOOLS.elevated);
Object.freeze(BUNDLED_OPENCLAW_TOOLS.exec);
Object.freeze(BUNDLED_OPENCLAW_TOOLS);
Object.freeze(BUNDLED_OPENCLAW_SANDBOX.docker);
Object.freeze(BUNDLED_OPENCLAW_SANDBOX);

/** Exact native gateway and observation capabilities for one acquired case. */
export interface EvaluationCaseInstrumentation<
  Gateway,
  DriverFailure,
  PeerRuntimes extends EvaluationCasePeerRuntimes,
> {
  readonly definition: EvaluationCaseDefinition<PeerRuntimes>;
  readonly policy: EvaluationExecutionPolicy;
  readonly target: StartedAgent<typeof TARGET_AGENT_NAME, Gateway>;
  readonly peers: EvaluationCasePeers<PeerRuntimes>;
  readonly driver: PrincipalDriver<Gateway, DriverFailure>;
  readonly emit: EmitEvaluationEvent;
}

interface CaseEvidenceContext {
  readonly caseId: EvaluationCaseId;
  readonly policy: EvaluationExecutionPolicy;
  readonly emit: EmitEvaluationEvent;
}

function detail(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  const rendered = String(cause).trim();
  return rendered.length > 0
    ? rendered
    : "operation failed without a diagnostic";
}

function programFailure(
  operation: EvaluationProgramFailed["operation"],
  cause: unknown,
): EvaluationProgramFailed {
  return EvaluationProgramFailed.make({ operation, detail: detail(cause) });
}

function emitObservation(
  emit: EmitEvaluationEvent,
  observation: EvaluationPeerObservation,
): Effect.Effect<EvaluationEvidenceId, EvaluationProgramFailed> {
  return emit(observation).pipe(
    Effect.map((record) => decodeEvaluationEvidenceId(record.eventId)),
    Effect.mapError((cause) => programFailure("evidence", cause)),
  );
}

function emitSelection(
  emit: EmitEvaluationEvent,
  caseId: EvaluationCaseId,
  selectedEventId: EvaluationEvidenceId,
): Effect.Effect<void, EvaluationProgramFailed> {
  return emit(
    EvaluationEvidenceSelected.make({ caseId, selectedEventId }),
  ).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => programFailure("evidence", cause)),
  );
}

function emitUnselectedExchange(
  emit: EmitEvaluationEvent,
  exchange: PeerExchange,
): Effect.Effect<void, EvaluationProgramFailed> {
  return Effect.forEach(
    exchange.observations,
    (observation) => emitObservation(emit, observation),
    { concurrency: 1, discard: true },
  );
}

function emitSelectedExchange(
  emit: EmitEvaluationEvent,
  exchange: PeerExchange,
): Effect.Effect<EvaluationEvidenceId, EvaluationProgramFailed> {
  return Effect.gen(function* () {
    yield* Effect.forEach(
      Arr.dropRight(exchange.observations, 1),
      (observation) => emitObservation(emit, observation),
      { concurrency: 1, discard: true },
    );
    return yield* emitObservation(
      emit,
      Arr.lastNonEmpty(exchange.observations),
    );
  });
}

function observePeer(
  gateway: EvaluationPeerGateway,
  within: Duration.Duration,
): Effect.Effect<Option.Option<PeerExchange>, EvaluationProgramFailed> {
  return gateway.exchange.pipe(
    Effect.timeoutOption(within),
    Effect.mapError((cause) => programFailure("peer", cause)),
  );
}

function emitPeerTimeout(
  emit: EmitEvaluationEvent,
  caseId: EvaluationCaseId,
  peer: EvaluationCasePeer,
  within: Duration.Duration,
): Effect.Effect<EvaluationEvidenceId, EvaluationProgramFailed> {
  return emit(
    PeerExchangeNotObserved.make({
      caseId,
      agentName: decodeAgentName(peer.agent.name),
      agentId: peer.agent.id,
      timeoutMillis: Duration.toMillis(within),
    }),
  ).pipe(
    Effect.map((record) => decodeEvaluationEvidenceId(record.eventId)),
    Effect.mapError((cause) => programFailure("evidence", cause)),
  );
}

function observeContextPeer(
  instrumentation: CaseEvidenceContext,
  peer: EvaluationCasePeer,
): Effect.Effect<void, EvaluationProgramFailed> {
  const within = instrumentation.policy.peerObservationTimeout;
  return observePeer(peer.gateway, within).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          emitPeerTimeout(
            instrumentation.emit,
            instrumentation.caseId,
            peer,
            within,
          ).pipe(Effect.asVoid),
        onSome: (exchange) =>
          emitUnselectedExchange(instrumentation.emit, exchange),
      }),
    ),
  );
}

function selectPeerOutput(
  instrumentation: CaseEvidenceContext,
  peer: EvaluationCasePeer,
): Effect.Effect<EvaluationEvidenceId, EvaluationProgramFailed> {
  const within = instrumentation.policy.peerObservationTimeout;
  return observePeer(peer.gateway, within).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          emitPeerTimeout(
            instrumentation.emit,
            instrumentation.caseId,
            peer,
            within,
          ),
        onSome: (exchange) =>
          emitSelectedExchange(instrumentation.emit, exchange),
      }),
    ),
  );
}

function runtimeStopped(
  target: StartedAgent<typeof TARGET_AGENT_NAME, unknown>,
): Effect.Effect<never, EvaluationProgramFailed> {
  return target.termination.pipe(
    Effect.flatMap((termination) =>
      Effect.fail(
        programFailure(
          "runtime",
          `target runtime terminated during the case: ${termination._tag}`,
        ),
      ),
    ),
  );
}

function principalInstruction<
  Gateway,
  DriverFailure,
  PeerRuntimes extends EvaluationCasePeerRuntimes,
>(
  instrumentation: EvaluationCaseInstrumentation<
    Gateway,
    DriverFailure,
    PeerRuntimes
  >,
  message: string,
): Effect.Effect<Option.Option<EvaluationEvidenceId>, EvaluationProgramFailed> {
  return instrumentation.driver
    .drive(
      instrumentation.target,
      {
        caseId: instrumentation.definition.id,
        message,
      },
      instrumentation.emit,
    )
    .pipe(Effect.mapError((cause) => programFailure("principal", cause)));
}

function observePrincipal<
  Gateway,
  DriverFailure,
  PeerRuntimes extends EvaluationCasePeerRuntimes,
>(
  instrumentation: EvaluationCaseInstrumentation<
    Gateway,
    DriverFailure,
    PeerRuntimes
  >,
): Effect.Effect<never, EvaluationProgramFailed> {
  return instrumentation.driver
    .observe(
      instrumentation.target,
      instrumentation.definition.id,
      instrumentation.emit,
    )
    .pipe(Effect.mapError((cause) => programFailure("principal", cause)));
}

function selectPrincipalOutput(
  output: Option.Option<EvaluationEvidenceId>,
): Effect.Effect<EvaluationEvidenceId, EvaluationProgramFailed> {
  return Option.match(output, {
    onNone: () =>
      Effect.fail(
        programFailure(
          "principal",
          "the native principal gateway does not correlate a terminal output with this instruction",
        ),
      ),
    onSome: Effect.succeed,
  });
}

function caseContext<
  Gateway,
  DriverFailure,
  PeerRuntimes extends EvaluationCasePeerRuntimes,
>(
  instrumentation: EvaluationCaseInstrumentation<
    Gateway,
    DriverFailure,
    PeerRuntimes
  >,
): EvaluationCaseProgramContext<PeerRuntimes, EvaluationProgramFailed> {
  const evidence = {
    caseId: instrumentation.definition.id,
    policy: instrumentation.policy,
    emit: instrumentation.emit,
  };
  return {
    peers: instrumentation.peers,
    instruct: (message) => principalInstruction(instrumentation, message),
    selectPrincipalOutput,
    observeContext: (peer) => observeContextPeer(evidence, peer),
    selectPeerOutput: (peer) => selectPeerOutput(evidence, peer),
  };
}

function runCaseProgram<
  Gateway,
  DriverFailure,
  PeerRuntimes extends EvaluationCasePeerRuntimes,
>(
  instrumentation: EvaluationCaseInstrumentation<
    Gateway,
    DriverFailure,
    PeerRuntimes
  >,
) {
  const program = Effect.gen(function* () {
    const selectedEventId = yield* instrumentation.definition.program(
      caseContext(instrumentation),
    );
    yield* emitSelection(
      instrumentation.emit,
      instrumentation.definition.id,
      selectedEventId,
    );
  }).pipe(
    Effect.raceFirst(observePrincipal(instrumentation)),
    Effect.raceFirst(runtimeStopped(instrumentation.target)),
  );
  return program.pipe(
    Effect.timeoutFail({
      duration: instrumentation.policy.caseTimeout,
      onTimeout: () =>
        programFailure(
          "timeout",
          `case ${instrumentation.definition.id} exceeded ${Duration.format(instrumentation.policy.caseTimeout)}`,
        ),
    }),
  );
}

/**
 * Execute one acquired case through its concrete principal adapter.
 * @param instrumentation Acquired target, peer observations, and event writer.
 * @returns The completed case program.
 * @internal
 */
export function runEvaluationCase<
  Gateway,
  DriverFailure,
  PeerRuntimes extends EvaluationCasePeerRuntimes,
>(
  instrumentation: EvaluationCaseInstrumentation<
    Gateway,
    DriverFailure,
    PeerRuntimes
  >,
): Effect.Effect<void, EvaluationProgramFailed> {
  return runCaseProgram(instrumentation).pipe(Effect.withSpan("evals.case"));
}

interface ExecuteConditionInput<
  Gateway,
  DriverFailure,
  PeerRuntimes extends EvaluationCasePeerRuntimes,
  RuntimeFailure,
  RuntimeRequirements,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
> {
  readonly runtime: AgentRuntime<
    Gateway,
    RuntimeFailure,
    RuntimeRequirements,
    ConfigurationSchema
  >;
  readonly principal: PrincipalDriverFactory<Gateway, DriverFailure>;
  readonly policy: EvaluationExecutionPolicy;
  readonly conditionId: ConditionId;
  readonly definition: EvaluationCaseDefinition<PeerRuntimes>;
  readonly execution: EvaluationExecutionInput;
}

function makeConditionRoster<
  Gateway,
  PeerRuntimes extends EvaluationCasePeerRuntimes,
  RuntimeFailure,
  RuntimeRequirements,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  runtime: AgentRuntime<
    Gateway,
    RuntimeFailure,
    RuntimeRequirements,
    ConfigurationSchema
  >,
  definition: EvaluationCaseDefinition<PeerRuntimes>,
) {
  return behavioralEvaluation.agents({
    ...definition.peers,
    [TARGET_AGENT_NAME]: runtime,
  });
}

function summarizeProgramFinished<Success>(
  outcome: ProgramFinished<Success, EvaluationProgramFailed>,
): EvaluationExecutionResult {
  return Exit.isSuccess(outcome.exit)
    ? EvaluationExecutionCompleted.make({
        receipt: outcome.receipt,
      })
    : EvaluationExecutionFailed.make({
        receipt: outcome.receipt,
        detail: Cause.pretty(outcome.exit.cause),
      });
}

interface InfrastructureFailureOutcome {
  readonly receipt: LedgerReceipt;
  readonly cause: Cause.Cause<unknown>;
}

function summarizeInfrastructureFailure(
  outcome: InfrastructureFailureOutcome,
): EvaluationExecutionResult {
  return EvaluationExecutionFailed.make({
    receipt: outcome.receipt,
    detail: Cause.pretty(outcome.cause),
  });
}

function summarizeOutcome<Success>(
  outcome:
    | ProgramFinished<Success, EvaluationProgramFailed>
    | InfrastructureFailureOutcome,
): EvaluationExecutionResult {
  return outcome instanceof ProgramFinished
    ? summarizeProgramFinished(outcome)
    : summarizeInfrastructureFailure(outcome);
}

function runProvenance(
  conditionId: ConditionId,
  definition: EvaluationCaseMetadata,
  execution: EvaluationExecutionInput,
) {
  return {
    provenance: {
      caseId: definition.id,
      caseDefinitionId: definition.definitionId,
      conditionId,
      attemptId: execution.attemptId,
    },
  };
}

function executeCondition<
  Gateway,
  DriverFailure,
  PeerRuntimes extends EvaluationCasePeerRuntimes,
  RuntimeFailure,
  RuntimeRequirements,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  input: ExecuteConditionInput<
    Gateway,
    DriverFailure,
    PeerRuntimes,
    RuntimeFailure,
    RuntimeRequirements,
    ConfigurationSchema
  >,
) {
  const { conditionId, definition, principal, execution, policy, runtime } =
    input;
  const roster = makeConditionRoster(runtime, definition);
  const program = Effect.gen(function* () {
    const agents = yield* roster.startedAgents;
    const events = yield* behavioralEvaluation.events;
    const { [TARGET_AGENT_NAME]: target, ...peers } = agents;
    const driver = yield* principal.make(execution.attemptId);
    yield* runEvaluationCase({
      definition,
      policy,
      target,
      peers,
      driver,
      emit: events.emit,
    });
  });
  return behavioralEvaluation
    .run(roster, program, runProvenance(conditionId, definition, execution))
    .pipe(Effect.map(summarizeOutcome));
}

/**
 * Capture one exact runtime gateway and its evaluation-local adapter.
 * @param definition Code-owned condition definition.
 * @returns A condition that exposes no simulator-wide gateway union.
 */
function evaluationCondition<
  Gateway,
  DriverFailure,
  RuntimeFailure,
  RuntimeRequirements,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  definition: EvaluationConditionDefinition<
    Gateway,
    DriverFailure,
    RuntimeFailure,
    RuntimeRequirements,
    ConfigurationSchema
  >,
): EvaluationCondition<RuntimeRequirements> {
  return Object.freeze({
    id: definition.id,
    runtimeName: definition.runtime.name,
    runtimeConfiguration: runtimeConfigurationProjection(definition.runtime),
    execute: <PeerRuntimes extends EvaluationCasePeerRuntimes>(
      evaluation: EvaluationCaseDefinition<PeerRuntimes>,
      input: EvaluationExecutionInput,
    ) =>
      executeCondition({
        runtime: definition.runtime,
        principal: definition.principal,
        policy: definition.execution,
        conditionId: definition.id,
        definition: evaluation,
        execution: input,
      }),
  });
}

/**
 * Build the OpenClaw condition around its exact native gateway.
 * @param options Native runtime configuration and customer deadlines.
 * @returns A condition whose executor retains the OpenClaw gateway type.
 */
export function openClawEvaluationCondition(
  options: OpenClawEvaluationConditionOptions,
) {
  const id = decodeConditionId("openclaw/v2");
  const runtime = openClawRuntime({
    ...options.runtime,
    tools: BUNDLED_OPENCLAW_TOOLS,
    sandbox: BUNDLED_OPENCLAW_SANDBOX,
  });
  return evaluationCondition({
    id,
    runtime,
    principal: openClawPrincipalDriver,
    execution: options.execution,
  });
}

/**
 * Build the NanoClaw condition around its exact native gateway.
 * @param options Native runtime configuration and customer deadlines.
 * @returns A condition whose executor retains the NanoClaw gateway type.
 */
export function nanoclawEvaluationCondition(
  options: NanoclawEvaluationConditionOptions,
) {
  const id = decodeConditionId("nanoclaw/v2");
  const runtime = nanoclawRuntime(options.runtime);
  return evaluationCondition({
    id,
    runtime,
    principal: nanoclawPrincipalDriver,
    execution: options.execution,
  });
}
