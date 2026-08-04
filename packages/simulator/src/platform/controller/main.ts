/** @file Executable boundary for exactly one mounted simulator RunSpec. */

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Direct-entry identity must be synchronous before the controller Effect exists, and canonical paths are required to resolve image symlinks.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Cause, Data, Effect } from "effect";
import { Run, type RunSpec } from "../../definition.js";
import {
  CompletedLedgerReceipt,
  ProgramFinished,
  RunInfrastructureFailed,
} from "../../kernel/run.js";
import { LedgerStorageError } from "../../ledger/storage.js";
import {
  controllerConfigurationFromEnvironment,
  type ControllerEnvironment,
} from "./configuration.js";
import {
  exportCompletedLedger,
  type ControllerLedgerExportInput,
} from "./ledger-export.js";
import {
  encodeControllerRunSummary,
  ledgerAllocationFailedSummary,
  programFinishedSummary,
  runInfrastructureFailedSummary,
  type ControllerFailedRunSummary,
  type ControllerRunSummary,
} from "./summary.js";

/** Stable stage labels used by sanitized controller failures. */
export const CONTROLLER_STAGE = Object.freeze({
  configuration: "configuration",
  moduleLoad: "module-load",
  execution: "execution",
} as const);

type ControllerStage = (typeof CONTROLLER_STAGE)[keyof typeof CONTROLLER_STAGE];
type ExperimentModuleImporter = (specifier: string) => PromiseLike<unknown>;
type RunSpecExecutor = (runSpec: RunSpec) => Effect.Effect<unknown, unknown>;
type CompletedLedgerExporter = (
  input: ControllerLedgerExportInput,
) => Effect.Effect<void, unknown>;

/** Safe controller failure reported to the Job without customer error values. */
export class ControllerFailure extends Data.TaggedError("ControllerFailure")<{
  readonly stage: ControllerStage;
  readonly detail: string;
  readonly summary?: ControllerFailedRunSummary;
}> {
  override get message(): string {
    return `Simulator controller ${this.stage} failed: ${this.detail}`;
  }
}

/** Replaceable process-boundary operations used by deterministic tests. */
export interface ControllerOperations {
  readonly importModule: ExperimentModuleImporter;
  readonly executeRunSpec: RunSpecExecutor;
  readonly exportCompletedLedger: CompletedLedgerExporter;
}

function failure(
  stage: ControllerStage,
  detail: string,
  summary?: ControllerFailedRunSummary,
): ControllerFailure {
  return new ControllerFailure({ stage, detail, summary });
}

function executionFailure(): ControllerFailure {
  return failure(
    CONTROLLER_STAGE.execution,
    "the experiment run did not complete",
  );
}

function executionFailureWithSummary(
  summary: ControllerFailedRunSummary,
): ControllerFailure {
  return failure(
    CONTROLLER_STAGE.execution,
    "the experiment run did not complete",
    summary,
  );
}

function allocationFailureSummary(
  cause: Cause.Cause<unknown>,
): ControllerFailedRunSummary | undefined {
  const failures = Array.from(Cause.failures(cause));
  return failures.length === 1 &&
    failures[0] instanceof LedgerStorageError &&
    failures[0].operation === "allocate"
    ? ledgerAllocationFailedSummary()
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunSpec(value: unknown): value is RunSpec {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.id !== "string") {
    return false;
  }
  if (!Array.isArray(value.events)) {
    return false;
  }
  if (!isRecord(value.agents)) {
    return false;
  }
  if (!isRecord(value.infrastructure)) {
    return false;
  }
  return typeof value.execute === "function";
}

function decodeExperimentModule(
  value: unknown,
): Effect.Effect<RunSpec, ControllerFailure> {
  if (!isRecord(value)) {
    return Effect.fail(
      failure(
        CONTROLLER_STAGE.moduleLoad,
        "the experiment module has no named exports",
      ),
    );
  }
  const exports = Object.keys(value);
  if (
    exports.length !== 1 ||
    exports[0] !== "runSpec" ||
    !isRunSpec(value.runSpec)
  ) {
    return Effect.fail(
      failure(
        CONTROLLER_STAGE.moduleLoad,
        "the experiment module must export only one named runSpec",
      ),
    );
  }
  return Effect.succeed(value.runSpec);
}

function defaultImporter(specifier: string): PromiseLike<unknown> {
  return import(specifier);
}

function defaultExecutor(runSpec: RunSpec): Effect.Effect<unknown, unknown> {
  return Effect.suspend(() => Run.execute(runSpec));
}

const liveOperations: ControllerOperations = Object.freeze({
  importModule: defaultImporter,
  executeRunSpec: defaultExecutor,
  exportCompletedLedger: (input: ControllerLedgerExportInput) =>
    exportCompletedLedger(input).pipe(Effect.provide(NodeContext.layer)),
});

function loadExperiment(
  path: string,
  importer: ExperimentModuleImporter,
): Effect.Effect<RunSpec, ControllerFailure> {
  return Effect.tryPromise({
    try: () => importer(pathToFileURL(path).href),
    catch: () =>
      failure(
        CONTROLLER_STAGE.moduleLoad,
        "the experiment module could not be loaded",
      ),
  }).pipe(Effect.flatMap(decodeExperimentModule));
}

function readConfiguration(
  environment: ControllerEnvironment,
): Effect.Effect<
  ReturnType<typeof controllerConfigurationFromEnvironment>,
  ControllerFailure
> {
  return Effect.try({
    try: () => controllerConfigurationFromEnvironment(environment),
    catch: () =>
      failure(
        CONTROLLER_STAGE.configuration,
        "the controller environment is invalid",
      ),
  });
}

function acceptRunOutcome(
  outcome: unknown,
): Effect.Effect<ControllerRunSummary, ControllerFailure> {
  if (outcome instanceof ProgramFinished) {
    return Effect.succeed(programFinishedSummary(outcome.receipt));
  }
  if (outcome instanceof RunInfrastructureFailed) {
    return Effect.fail(
      executionFailureWithSummary(
        runInfrastructureFailedSummary(outcome.receipt),
      ),
    );
  }
  return Effect.fail(executionFailure());
}

function completedReceipt(
  outcome: unknown,
): CompletedLedgerReceipt | undefined {
  if (outcome instanceof ProgramFinished) {
    return outcome.receipt;
  }
  if (
    outcome instanceof RunInfrastructureFailed &&
    outcome.receipt instanceof CompletedLedgerReceipt
  ) {
    return outcome.receipt;
  }
  return undefined;
}

function retainCompletedLedger(
  configuration: ReturnType<typeof controllerConfigurationFromEnvironment>,
  outcome: unknown,
  exporter: CompletedLedgerExporter,
): Effect.Effect<unknown, ControllerFailure> {
  const receipt = completedReceipt(outcome);
  if (
    receipt === undefined ||
    configuration.ledgerExportDirectory === undefined
  ) {
    return Effect.succeed(outcome);
  }
  return exporter({
    ledgerDirectory: configuration.ledgerDirectory,
    exportDirectory: configuration.ledgerExportDirectory,
    receipt,
  }).pipe(
    Effect.mapError(() =>
      executionFailureWithSummary(runInfrastructureFailedSummary(receipt)),
    ),
    Effect.as(outcome),
  );
}

/**
 * Load and invoke one exact mounted RunSpec with no replay or fallback path.
 * @param environment Controller Job environment.
 * @param operations Process-boundary operations, replaceable only by tests.
 * @returns The completed Run.execute value.
 */
export function runControllerWith(
  environment: ControllerEnvironment,
  operations: ControllerOperations,
): Effect.Effect<ControllerRunSummary, ControllerFailure> {
  return readConfiguration(environment).pipe(
    Effect.flatMap((configuration) =>
      loadExperiment(
        configuration.experimentModule,
        operations.importModule,
      ).pipe(
        Effect.flatMap((runSpec) =>
          operations.executeRunSpec(runSpec).pipe(
            Effect.sandbox,
            Effect.mapError((cause) => {
              const summary = allocationFailureSummary(cause);
              return summary === undefined
                ? executionFailure()
                : executionFailureWithSummary(summary);
            }),
          ),
        ),
        Effect.flatMap((outcome) =>
          retainCompletedLedger(
            configuration,
            outcome,
            operations.exportCompletedLedger,
          ),
        ),
        Effect.flatMap(acceptRunOutcome),
      ),
    ),
  );
}

function processControllerEnvironment(): ControllerEnvironment {
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- The executable controller captures its environment once before entering the typed decoder.
  return process.env;
}

/**
 * Execute the one RunSpec mounted into this controller process.
 * @param environment Optional injected environment used by deterministic tests.
 * @returns The completed Run.execute value or a sanitized controller failure.
 */
function runController(
  environment?: ControllerEnvironment,
): Effect.Effect<ControllerRunSummary, ControllerFailure> {
  const resolvedEnvironment = environment ?? processControllerEnvironment();
  return runControllerWith(resolvedEnvironment, liveOperations);
}

/**
 * Compare an argv entrypoint with its loaded module after resolving symlinks.
 * @param moduleUrl Canonical URL assigned to the loaded ES module by Node.
 * @param invoked Path passed to Node as the executable module.
 * @returns Whether both paths identify the same physical module.
 */
export function isControllerModuleInvocation(
  moduleUrl: string,
  invoked?: string,
): boolean {
  if (invoked === undefined) {
    return false;
  }
  const invokedPath = realpathSync(resolve(invoked));
  const loadedPath = realpathSync(fileURLToPath(moduleUrl));
  return invokedPath === loadedPath;
}

function isDirectInvocation(): boolean {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Direct-entry detection has no Effect Platform equivalent.
  const invoked = process.argv[1];
  return isControllerModuleInvocation(import.meta.url, invoked);
}

function resultHandoffFailure(): ControllerFailure {
  return failure(
    CONTROLLER_STAGE.execution,
    "the controller result could not be handed off",
  );
}

function writeControllerSummary(
  summary: ControllerRunSummary,
): Effect.Effect<void, ControllerFailure> {
  const encoded = encodeControllerRunSummary(summary);
  if (encoded === undefined) {
    return Effect.fail(resultHandoffFailure());
  }
  return Effect.try({
    try: () => process.stdout.write(`${encoded}\n`),
    catch: resultHandoffFailure,
  }).pipe(Effect.asVoid);
}

function writeControllerDiagnostic(message: string): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stderr.write(`${message}\n`);
  });
}

function reportControllerFailure(
  controllerFailure: ControllerFailure,
): Effect.Effect<never, ControllerFailure> {
  const summary = controllerFailure.summary;
  const writeSummary =
    summary === undefined
      ? Effect.void
      : writeControllerSummary(summary).pipe(
          Effect.catchAll((summaryFailure) =>
            writeControllerDiagnostic(summaryFailure.message),
          ),
        );
  return writeSummary.pipe(
    Effect.zipRight(writeControllerDiagnostic(controllerFailure.message)),
    Effect.zipRight(Effect.fail(controllerFailure)),
  );
}

if (isDirectInvocation()) {
  runController().pipe(
    Effect.flatMap(writeControllerSummary),
    Effect.catchAll(reportControllerFailure),
    NodeRuntime.runMain,
  );
}
