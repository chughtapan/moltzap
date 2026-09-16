/** @file Executable boundary for exactly one mounted simulator RunSpec. */

import { FileSystem } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { defaultTeardown } from "@effect/platform/Runtime";
import { Cause, Context, Data, Effect, Layer, Schema } from "effect";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isRunSpec, Run, type RunSpec } from "../../definition.js";
import {
  ClusterLost,
  CompletedLedgerReceipt,
  ProgramFinished,
} from "../../index.js";
import {
  ledgerArtifactFiles,
  LedgerCompletion,
  ledgerRef,
  LedgerStorageError,
} from "../../ledger/index.js";
import { isEntryModule } from "../entry.js";
import {
  controllerConfigurationFromEnvironment,
  type ControllerEnvironment,
} from "./configuration.js";
import {
  type ControllerLedgerExportOptions,
  exportCompletedLedger,
  filesystemLedgerExportOperations,
} from "./ledger-export.js";
import {
  clusterLostSummary,
  type ControllerFailedRunSummary,
  type ControllerRunSummary,
  encodeControllerRunSummary,
  ledgerAllocationFailedSummary,
  programFinishedSummary,
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
  options: ControllerLedgerExportOptions,
) => Effect.Effect<void, unknown>;

/** Safe controller failure reported to the Job without customer error values. */
export class ControllerError extends Data.TaggedError("ControllerError")<{
  readonly stage: ControllerStage;
  readonly detail: string;
  readonly summary?: ControllerFailedRunSummary;
}> {
  override get message(): string {
    return `Simulator controller ${this.stage} failed: ${this.detail}`;
  }
}

/** Process-boundary operations, replaceable by deterministic tests. */
export interface ControllerOperationsService {
  readonly importModule: ExperimentModuleImporter;
  readonly executeRunSpec: RunSpecExecutor;
  readonly exportCompletedLedger: CompletedLedgerExporter;
}

/** Process-boundary operations the controller reads from its environment. */
export class ControllerOperations extends Context.Tag(
  "@moltzap/simulator/ControllerOperations",
)<ControllerOperations, ControllerOperationsService>() {}

/**
 * Load and invoke one exact mounted RunSpec with no replay or fallback path.
 * @param environment Optional injected environment used by deterministic tests.
 * @returns The completed Run.execute value or a sanitized controller failure.
 */
export function runController(
  environment?: ControllerEnvironment,
): Effect.Effect<ControllerRunSummary, ControllerError, ControllerOperations> {
  const resolvedEnvironment = environment ?? processControllerEnvironment();
  return Effect.gen(function* () {
    const operations = yield* ControllerOperations;
    const configuration = yield* readConfiguration(resolvedEnvironment);
    const runSpec = yield* loadExperiment(
      configuration.experimentModule,
      operations.importModule,
    );
    const outcome = yield* operations.executeRunSpec(runSpec).pipe(
      Effect.onInterrupt(() =>
        retainInterruptedLedger(configuration).pipe(
          Effect.flatMap(writeControllerSummary),
          Effect.catchAll((error) => writeControllerDiagnostic(String(error))),
          Effect.provide(NodeContext.layer),
        ),
      ),
      Effect.sandbox,
      Effect.mapError((cause) => {
        const summary = allocationFailureSummary(cause);
        return summary === undefined
          ? executionFailure()
          : executionFailureWithSummary(summary);
      }),
    );
    const retained = yield* retainCompletedLedger(
      configuration,
      outcome,
      operations.exportCompletedLedger,
    );
    return yield* acceptRunOutcome(retained);
  }).pipe(Effect.withSpan("runController"));
}

class InterruptedLedgerUnavailable extends Data.TaggedError(
  "InterruptedLedgerUnavailable",
)<{ readonly detail: string }> {}

/**
 * Keep repeated stop requests harmless until ledger finalizers and export finish.
 * NodeRuntime removes its signal listeners when the first interruption starts;
 * this listener retains Node's handled-signal behavior through runtime teardown.
 */
export function runControllerProcess<A, E>(effect: Effect.Effect<A, E>): void {
  const absorbRepeatedSignal = () => undefined;
  process.on("SIGINT", absorbRepeatedSignal);
  process.on("SIGTERM", absorbRepeatedSignal);
  NodeRuntime.runMain(effect, {
    teardown: (exit, onExit) => {
      defaultTeardown(exit, onExit);
      process.removeListener("SIGINT", absorbRepeatedSignal);
      process.removeListener("SIGTERM", absorbRepeatedSignal);
    },
  });
}

/** Called only after Run.execute's interruption finalizers have closed the ledger. */
export function retainInterruptedLedger(configuration: {
  readonly ledgerDirectory: string;
  readonly ledgerExportDirectory?: string;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* Effect.filter(
      yield* fs.readDirectory(configuration.ledgerDirectory),
      (name) =>
        fs.exists(
          join(
            configuration.ledgerDirectory,
            name,
            ledgerArtifactFiles.completion,
          ),
        ),
    );
    if (names.length !== 1 || names[0] === undefined) {
      return yield* new InterruptedLedgerUnavailable({
        detail: "Interrupted controller has no unique completed ledger",
      });
    }
    const ledger = yield* Schema.decodeUnknown(ledgerRef)(names[0]);
    const completion = yield* Schema.decodeUnknown(
      Schema.parseJson(LedgerCompletion),
    )(
      yield* fs.readFileString(
        join(
          configuration.ledgerDirectory,
          ledger,
          ledgerArtifactFiles.completion,
        ),
      ),
    );
    const receipt = CompletedLedgerReceipt.make({ ledger, completion });
    if (configuration.ledgerExportDirectory !== undefined) {
      yield* exportCompletedLedger({
        ledgerDirectory: configuration.ledgerDirectory,
        exportDirectory: configuration.ledgerExportDirectory,
        receipt,
      }).pipe(Effect.provide(filesystemLedgerExportOperations));
    }
    return clusterLostSummary(receipt);
  }).pipe(Effect.withSpan("retainInterruptedLedger"));
}

function acceptRunOutcome(
  outcome: unknown,
): Effect.Effect<ControllerRunSummary, ControllerError> {
  if (outcome instanceof ProgramFinished) {
    return Effect.succeed(programFinishedSummary(outcome.receipt));
  }
  if (outcome instanceof ClusterLost) {
    return Effect.fail(
      executionFailureWithSummary(clusterLostSummary(outcome.receipt)),
    );
  }
  return Effect.fail(executionFailure());
}

function retainCompletedLedger(
  configuration: ReturnType<typeof controllerConfigurationFromEnvironment>,
  outcome: unknown,
  exporter: CompletedLedgerExporter,
): Effect.Effect<unknown, ControllerError> {
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
      executionFailureWithSummary(clusterLostSummary(receipt)),
    ),
    Effect.as(outcome),
  );
}

function completedReceipt(
  outcome: unknown,
): CompletedLedgerReceipt | undefined {
  if (outcome instanceof ProgramFinished) {
    return outcome.receipt;
  }
  if (
    outcome instanceof ClusterLost &&
    outcome.receipt instanceof CompletedLedgerReceipt
  ) {
    return outcome.receipt;
  }
  return undefined;
}

function executionFailure(): ControllerError {
  return failure(
    CONTROLLER_STAGE.execution,
    "the experiment run did not complete",
  );
}

function executionFailureWithSummary(
  summary: ControllerFailedRunSummary,
): ControllerError {
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

function decodeExperimentModule(
  value: unknown,
): Effect.Effect<RunSpec, ControllerError> {
  if (!isRecord(value)) {
    return Effect.fail(
      failure(
        CONTROLLER_STAGE.moduleLoad,
        "the experiment module has no named exports",
      ),
    );
  }
  const exports = Object.keys(value);
  if (exports.length !== 1 || exports[0] !== "runSpec") {
    return Effect.fail(
      failure(
        CONTROLLER_STAGE.moduleLoad,
        "the experiment module must export only one named runSpec",
      ),
    );
  }
  if (!isRunSpec(value.runSpec)) {
    return Effect.fail(
      failure(
        CONTROLLER_STAGE.moduleLoad,
        "the experiment module's runSpec was not produced by RunSpec.define",
      ),
    );
  }
  return Effect.succeed(value.runSpec);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultImporter(specifier: string): PromiseLike<unknown> {
  return import(specifier);
}

function defaultExecutor(runSpec: RunSpec): Effect.Effect<unknown, unknown> {
  return Effect.suspend(() => Run.execute(runSpec));
}

/** The process boundaries used by every controller that is not a test. */
export const liveControllerOperations: Layer.Layer<ControllerOperations> =
  Layer.succeed(ControllerOperations, {
    importModule: defaultImporter,
    executeRunSpec: defaultExecutor,
    exportCompletedLedger: (options: ControllerLedgerExportOptions) =>
      exportCompletedLedger(options).pipe(
        Effect.provide(
          filesystemLedgerExportOperations.pipe(
            Layer.provide(NodeContext.layer),
          ),
        ),
      ),
  });

function loadExperiment(
  path: string,
  importer: ExperimentModuleImporter,
): Effect.Effect<RunSpec, ControllerError> {
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
  ControllerError
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

function processControllerEnvironment(): ControllerEnvironment {
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- The executable controller captures its environment once before entering the typed decoder.
  return process.env;
}

function isDirectInvocation(): boolean {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Direct-entry detection has no Effect Platform equivalent.
  const invoked = process.argv[1];
  return isEntryModule(import.meta.url, invoked);
}

function reportControllerFailure(
  controllerFailure: ControllerError,
): Effect.Effect<never, ControllerError> {
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

function writeControllerSummary(
  summary: ControllerRunSummary,
): Effect.Effect<void, ControllerError> {
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

function resultHandoffFailure(): ControllerError {
  return failure(
    CONTROLLER_STAGE.execution,
    "the controller result could not be handed off",
  );
}

function failure(
  stage: ControllerStage,
  detail: string,
  summary?: ControllerFailedRunSummary,
): ControllerError {
  return new ControllerError({ stage, detail, summary });
}

if (isDirectInvocation()) {
  runController().pipe(
    Effect.flatMap(writeControllerSummary),
    Effect.catchAll(reportControllerFailure),
    Effect.provide(liveControllerOperations),
    runControllerProcess,
  );
}
