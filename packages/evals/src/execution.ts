/** @file Concrete mixed-agent conditions and code-defined case execution. */

import {
  type ClusterServices,
  CompletedLedgerReceipt,
  coreEvents,
  EventCatalog,
  isRunSpec,
  LedgerReceipt,
  ProgramFailed,
  ProgramInterrupted,
  ProgramSucceeded,
  RunSpec,
  SimulatorDefinitionError,
} from "@moltzap/simulator";
import {
  type AgentRuntime,
  nanoclawRuntime,
  type NanoClawRuntimeOptions,
  openClawRuntime,
  type OpenClawRuntimeOptions,
  runtimeConfigurationProjection,
  type StartedAgent,
} from "@moltzap/simulator/agents";
import {
  type CompletedLedgerArtifacts,
  type CompletedRunLedger,
  type JsonValue,
  type LedgerOpenError,
  type LedgerRef,
  type LedgerStorageError,
  openLedgerArtifacts,
} from "@moltzap/simulator/ledger";
import { Duration, Effect, type Layer, Option, Schema, Stream } from "effect";
import {
  type EvaluationCaseDefinition,
  type EvaluationCaseMetadata,
  type EvaluationCaseProgramContext,
  TARGET_AGENT_NAME,
} from "./cases.js";
import { evaluationEvents, EvaluationEvidenceSelected } from "./events.js";
import {
  decodeEvaluationConditionId,
  type EvaluationCaseId,
  type EvaluationConditionId,
  type EvaluationEvidenceId,
} from "./model.js";
import {
  type EmitEvaluationEvent,
  nanoclawPrincipalDriver,
  openClawPrincipalDriver,
  type PrincipalDriver,
  type PrincipalDriverFactory,
} from "./principal.js";

/** Controller-owned services required by every evaluation cell RunSpec. */
type EvaluationInfrastructure = Layer.Layer<
  ClusterServices,
  LedgerStorageError
>;

const evaluationCatalog = EventCatalog.merge(coreEvents, evaluationEvents);

/**
 * Reopen one case-specific RunSpec ledger against the exact evaluation catalog.
 * @param definition Bundled case whose definition id owns the ledger.
 * @param ref Physical ledger identity returned by the controller.
 * @param artifacts Immutable manifest, records, and completion artifact text.
 * @returns The fully validated completed evaluation ledger.
 */
export function openEvaluationLedger(
  definition: EvaluationCaseMetadata,
  ref: LedgerRef,
  artifacts: CompletedLedgerArtifacts,
) {
  return openLedgerArtifacts(
    evaluationCatalog,
    ref,
    artifacts,
    definition.definitionId,
  );
}

/** Customer-owned deadlines for observable behavior and complete case work. */
interface EvaluationExecutionPolicy {
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
    operation: Schema.Literal("principal", "evidence", "runtime", "timeout"),
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

/** A controller receipt disagrees with its completed evaluation ledger. */
export class EvaluationControllerResultInvalid extends Schema.TaggedError<EvaluationControllerResultInvalid>()(
  "EvaluationControllerResultInvalid",
  {
    detail: Schema.NonEmptyString,
  },
) {}

interface EvaluationConditionDefinitionConsumer<Result> {
  readonly execute: <
    Gateway,
    DriverFailure,
    RuntimeFailure,
    ConfigurationSchema extends Schema.Schema.AnyNoContext,
  >(
    definition: EvaluationConditionDefinition<
      Gateway,
      DriverFailure,
      RuntimeFailure,
      ConfigurationSchema
    >,
  ) => Result;
}

/** Concrete condition with its exact gateway retained behind a rank-2 binder. */
export interface EvaluationCondition {
  readonly id: EvaluationConditionId;
  readonly runtimeName: string;
  readonly runtimeConfiguration: JsonValue;
  readonly withDefinition: <Result>(
    consumer: EvaluationConditionDefinitionConsumer<Result>,
  ) => Result;
}

/** Exact runtime and adapter captured behind one code-defined condition. */
export interface EvaluationConditionDefinition<
  Gateway,
  DriverFailure,
  RuntimeFailure,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
> {
  readonly id: EvaluationConditionId;
  readonly runtime: AgentRuntime<Gateway, RuntimeFailure, ConfigurationSchema>;
  readonly principal: PrincipalDriverFactory<Gateway, DriverFailure>;
  readonly execution: EvaluationExecutionPolicy;
}

interface OpenClawEvaluationConditionOptions {
  readonly runtime: Omit<OpenClawRuntimeOptions, "tools" | "sandbox">;
  readonly execution: EvaluationExecutionPolicy;
}

interface NanoClawEvaluationConditionOptions {
  readonly runtime: NanoClawRuntimeOptions;
  readonly execution: EvaluationExecutionPolicy;
}

const BUNDLED_OPENCLAW_MESSAGE_TOOL = "message";
const BUNDLED_OPENCLAW_TOOLS = {
  allow: [BUNDLED_OPENCLAW_MESSAGE_TOOL],
  sandbox: {
    tools: {
      allow: [BUNDLED_OPENCLAW_MESSAGE_TOOL],
    },
  },
  elevated: { enabled: false },
  exec: { mode: "full" },
} satisfies NonNullable<OpenClawRuntimeOptions["tools"]>;

Object.freeze(BUNDLED_OPENCLAW_TOOLS.allow);
Object.freeze(BUNDLED_OPENCLAW_TOOLS.sandbox.tools.allow);
Object.freeze(BUNDLED_OPENCLAW_TOOLS.sandbox.tools);
Object.freeze(BUNDLED_OPENCLAW_TOOLS.sandbox);
Object.freeze(BUNDLED_OPENCLAW_TOOLS.elevated);
Object.freeze(BUNDLED_OPENCLAW_TOOLS.exec);
Object.freeze(BUNDLED_OPENCLAW_TOOLS);

/** Exact native gateway and observation capabilities for one acquired case. */
export interface EvaluationCaseInstrumentation<Gateway, DriverFailure> {
  readonly definition: EvaluationCaseDefinition;
  readonly policy: EvaluationExecutionPolicy;
  readonly target: StartedAgent<Gateway>;
  readonly driver: PrincipalDriver<Gateway, DriverFailure>;
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

function runtimeStopped(
  target: StartedAgent<unknown>,
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

function principalInstruction<Gateway, DriverFailure>(
  instrumentation: EvaluationCaseInstrumentation<Gateway, DriverFailure>,
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

function observePrincipal<Gateway, DriverFailure>(
  instrumentation: EvaluationCaseInstrumentation<Gateway, DriverFailure>,
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

function caseContext<Gateway, DriverFailure>(
  instrumentation: EvaluationCaseInstrumentation<Gateway, DriverFailure>,
): EvaluationCaseProgramContext<EvaluationProgramFailed> {
  return {
    instruct: (message) => principalInstruction(instrumentation, message),
    selectPrincipalOutput,
  };
}

function runCaseProgram<Gateway, DriverFailure>(
  instrumentation: EvaluationCaseInstrumentation<Gateway, DriverFailure>,
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
 * @param instrumentation Acquired target, principal driver, and event writer.
 * @returns The completed case program.
 * @internal
 */
export function runEvaluationCase<Gateway, DriverFailure>(
  instrumentation: EvaluationCaseInstrumentation<Gateway, DriverFailure>,
): Effect.Effect<void, EvaluationProgramFailed> {
  return runCaseProgram(instrumentation).pipe(Effect.withSpan("evals.case"));
}

interface ExecuteConditionInput<
  Gateway,
  DriverFailure,
  RuntimeFailure,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
> {
  readonly runtime: AgentRuntime<Gateway, RuntimeFailure, ConfigurationSchema>;
  readonly principal: PrincipalDriverFactory<Gateway, DriverFailure>;
  readonly policy: EvaluationExecutionPolicy;
  readonly definition: EvaluationCaseDefinition;
  readonly execution: EvaluationExecutionInput;
  readonly infrastructure: EvaluationInfrastructure;
}

function makeConditionRuntimes<
  Gateway,
  RuntimeFailure,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(runtime: AgentRuntime<Gateway, RuntimeFailure, ConfigurationSchema>) {
  return Object.freeze({ [TARGET_AGENT_NAME]: runtime });
}

type EvaluationCompletedLedger = CompletedRunLedger<typeof evaluationCatalog>;

type ProgramCompletionEvent =
  | ProgramSucceeded
  | ProgramFailed
  | ProgramInterrupted;

function completionEvents(
  ledger: EvaluationCompletedLedger,
): Effect.Effect<readonly ProgramCompletionEvent[]> {
  const initial: readonly ProgramCompletionEvent[] = [];
  return ledger.records.pipe(
    Stream.runFold(initial, (events, record) => {
      const event = record.event;
      return event instanceof ProgramSucceeded ||
        event instanceof ProgramFailed ||
        event instanceof ProgramInterrupted
        ? [...events, event]
        : events;
    }),
  );
}

function completionMatchesReceipt(
  ledger: EvaluationCompletedLedger,
  receipt: CompletedLedgerReceipt,
): boolean {
  const observed = ledger.completion;
  const claimed = receipt.completion;
  const sameHeader =
    observed.ledgerFormatVersion === claimed.ledgerFormatVersion &&
    observed.runId === claimed.runId &&
    observed.recordCount === claimed.recordCount;
  const sameManifest =
    observed.artifacts.manifest === claimed.artifacts.manifest;
  const sameRecords = observed.artifacts.records === claimed.artifacts.records;
  return sameHeader && sameManifest && sameRecords;
}

function projectProgramCompletion(
  event: ProgramCompletionEvent,
  receipt: CompletedLedgerReceipt,
): EvaluationExecutionResult {
  return event instanceof ProgramSucceeded
    ? EvaluationExecutionCompleted.make({ receipt })
    : EvaluationExecutionFailed.make({ receipt, detail: event.cause });
}

function projectCompletedLedger(
  ledger: EvaluationCompletedLedger,
  receipt: CompletedLedgerReceipt,
): Effect.Effect<EvaluationExecutionResult, EvaluationControllerResultInvalid> {
  return Effect.gen(function* () {
    if (!completionMatchesReceipt(ledger, receipt)) {
      return yield* EvaluationControllerResultInvalid.make({
        detail: "controller receipt completion does not match the ledger",
      });
    }
    const events = yield* completionEvents(ledger);
    if (events.length !== 1) {
      return yield* EvaluationControllerResultInvalid.make({
        detail: `completed evaluation ledger contains ${String(events.length)} program completion events`,
      });
    }
    const [event] = events;
    if (event === undefined) {
      return yield* EvaluationControllerResultInvalid.make({
        detail: "completed evaluation ledger has no program completion event",
      });
    }
    return projectProgramCompletion(event, receipt);
  });
}

/**
 * Reopen a controller-completed ledger and recover its customer-program result.
 * @param definition Bundled case that owns the ledger definition and catalog.
 * @param receipt Bounded controller result projected outside the run process.
 * @param artifacts Immutable artifacts retrieved for the receipt's ledger.
 * @returns The evaluation result recovered from canonical simulator evidence.
 */
export function projectEvaluationControllerResult(
  definition: EvaluationCaseMetadata,
  receipt: CompletedLedgerReceipt,
  artifacts: CompletedLedgerArtifacts,
): Effect.Effect<
  EvaluationExecutionResult,
  LedgerOpenError | EvaluationControllerResultInvalid
> {
  return openEvaluationLedger(definition, receipt.ledger, artifacts).pipe(
    Effect.flatMap((ledger) => projectCompletedLedger(ledger, receipt)),
  );
}

/**
 * Construct one case-and-condition RunSpec using an injected infrastructure Layer.
 * @param input Exact target runtime, policy, and infrastructure.
 * @returns The immutable RunSpec for one evaluation matrix cell.
 */
function evaluationRunSpec<
  Gateway,
  DriverFailure,
  RuntimeFailure,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  input: ExecuteConditionInput<
    Gateway,
    DriverFailure,
    RuntimeFailure,
    ConfigurationSchema
  >,
) {
  const { definition, infrastructure, principal, execution, policy, runtime } =
    input;
  return RunSpec.define({
    id: definition.definitionId,
    events: [evaluationEvents],
    agents: makeConditionRuntimes(runtime),
    cluster: infrastructure,
    execute: ({ agents, events }) => {
      const { [TARGET_AGENT_NAME]: target } = agents;
      return Effect.gen(function* () {
        const driver = yield* principal.make(execution.attemptId);
        yield* runEvaluationCase({
          definition,
          policy,
          target,
          driver,
          emit: events.emit,
        });
      });
    },
  });
}

/** Inputs that bind one report cell to a controller-owned infrastructure Layer. */
interface EvaluationCellRunSpecInput {
  readonly definition: EvaluationCaseDefinition;
  readonly condition: EvaluationCondition;
  readonly attemptId: string;
  readonly infrastructure: EvaluationInfrastructure;
}

/**
 * Construct exactly one case-by-condition controller RunSpec.
 * @param input Exact case, condition, attempt, and infrastructure.
 * @returns One immutable controller-owned RunSpec.
 */
export function evaluationCellRunSpec(
  input: EvaluationCellRunSpecInput,
): RunSpec {
  return input.condition.withDefinition({
    execute: (condition): RunSpec => {
      const specification = evaluationRunSpec({
        runtime: condition.runtime,
        principal: condition.principal,
        policy: condition.execution,
        definition: input.definition,
        execution: { attemptId: input.attemptId },
        infrastructure: input.infrastructure,
      });
      if (!isRunSpec(specification)) {
        throw SimulatorDefinitionError.make({
          definitionId: input.definition.definitionId,
          detail: "RunSpec.define returned an invalid evaluation cell",
        });
      }
      return specification;
    },
  });
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
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  definition: EvaluationConditionDefinition<
    Gateway,
    DriverFailure,
    RuntimeFailure,
    ConfigurationSchema
  >,
): EvaluationCondition {
  return Object.freeze({
    id: definition.id,
    runtimeName: definition.runtime.name,
    runtimeConfiguration: runtimeConfigurationProjection(definition.runtime),
    withDefinition: <Result>(
      consumer: EvaluationConditionDefinitionConsumer<Result>,
    ) => consumer.execute(definition),
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
  const id = decodeEvaluationConditionId("openclaw/v2");
  const runtime = openClawRuntime({
    ...options.runtime,
    tools: BUNDLED_OPENCLAW_TOOLS,
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
  options: NanoClawEvaluationConditionOptions,
) {
  const id = decodeEvaluationConditionId("nanoclaw/v2");
  const runtime = nanoclawRuntime(options.runtime);
  return evaluationCondition({
    id,
    runtime,
    principal: nanoclawPrincipalDriver,
    execution: options.execution,
  });
}
