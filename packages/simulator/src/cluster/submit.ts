/** @file Shared submission of one experiment to a Temporal-managed cluster. */

import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { type Cause, Context, Data, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { KubernetesExecutionProfile } from "./profile.js";
import type { ProfileRunResult } from "./profiles/result.js";
import type {
  RunControllerResult,
  RunSocietyWorkflowInput,
} from "./reclaim.js";
import { FORCE_WORKER_ROLL_VARIABLE, RunWorkerRollRefused } from "./install.js";
import {
  runTemporalSociety,
  type RunTemporalSocietyOptions,
} from "./temporal.js";

/* eslint-disable agent-code-guard/promise-type -- File loading and the Temporal SDK are Promise-native at this submission boundary. */

/** Temporal queue used by the repository-owned local profile. */
export const DEFAULT_LOCAL_TASK_QUEUE = "moltzap-simulator";
const DEFAULT_TEMPORAL_ADDRESS = "127.0.0.1:7233";
const DEFAULT_TEMPORAL_NAMESPACE = "default";
const DIGEST_PINNED_IMAGE = /^.+@sha256:[0-9a-f]{64}$/u;

/** Process environment read by a submitting profile. */
export type RunEnvironment = Readonly<Record<string, string | undefined>>;

/** Stable stage labels used by the sanitized submission failure. */
export const SUBMIT_STAGE = Object.freeze({
  arguments: "arguments",
  configuration: "configuration",
  module: "module",
  execution: "execution",
} as const);

/** Native submission boundaries, replaceable by entry-point tests. */
export interface SubmitOperationsService {
  /** Reads both the experiment module and a profile's checked-in JSON. */
  readonly readTextFile: (path: string) => Effect.Effect<string, unknown>;
  readonly randomUuid: () => string;
  readonly runTemporalSociety: (
    options: RunTemporalSocietyOptions,
  ) => Promise<RunControllerResult>;
}

/** Native submission boundaries every profile reads from its environment. */
export class SubmitOperations extends Context.Tag(
  "@moltzap/simulator/SubmitOperations",
)<SubmitOperations, SubmitOperationsService>() {}

/**
 * Upper bound on the diagnostic one submission publishes to its caller.
 *
 * The stdout line is a contract, and an unbounded field makes the whole line
 * long rather than the one field long.
 */
export const SUBMITTED_DIAGNOSTIC_MAX_BYTES = 8 * 1_024;

/** Successful submission reported to the operator. */
export type RunSubmission = ProfileRunResult;

/** Sanitized failure at the repository-owned submission boundary. */
export class RunSubmissionError extends Data.TaggedError("RunSubmissionError")<{
  readonly stage: "arguments" | "configuration" | "module" | "execution";
  readonly detail: string;
}> {
  override get message(): string {
    return `Simulator ${this.stage} failed: ${this.detail}`;
  }
}

/** The native boundaries used by every submission that is not a test. */
export const liveSubmitOperations: Layer.Layer<SubmitOperations> =
  Layer.succeed(SubmitOperations, {
    readTextFile: (path: string) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
        Effect.provide(NodeContext.layer),
      ),
    randomUuid: randomUUID,
    runTemporalSociety,
  });

/**
 * Submit through the shared Kubernetes path with one private host profile.
 * @param args One repository-local `.mjs` RunSpec path.
 * @param environment Image and Temporal connection configuration.
 * @param executionProfile Host-owned Kubernetes cluster selection.
 * @returns The coarse workflow result and ephemeral run identity.
 */
export function runKubernetesSociety(
  args: readonly string[],
  environment: RunEnvironment,
  executionProfile: KubernetesExecutionProfile,
): Effect.Effect<RunSubmission, RunSubmissionError, SubmitOperations> {
  return Effect.try({
    try: () => prepareRun(args, environment, executionProfile),
    catch: (cause) =>
      cause instanceof RunSubmissionError
        ? cause
        : failure("configuration", "the run configuration was invalid"),
  }).pipe(
    Effect.flatMap((prepared) =>
      Effect.flatMap(SubmitOperations, (operations) =>
        executePreparedRun(prepared, operations),
      ),
    ),
    Effect.withSpan("runKubernetesSociety"),
  );
}

/**
 * Hold a diagnostic to the published byte bound, keeping its tail.
 *
 * The tail because a controller writes the reason it stopped last. On the byte
 * array because a UTF-16 slice cannot express a byte count, and the
 * continuation-byte skip puts the cut on a code-point boundary rather than
 * leaving a replacement character at the front.
 *
 * @param value Sanitized controller output collected by the host activity.
 * @returns The same text, or its last whole code points within the bound.
 */
export function boundedDiagnostic(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= SUBMITTED_DIAGNOSTIC_MAX_BYTES) {
    return value;
  }
  let start = bytes.byteLength - SUBMITTED_DIAGNOSTIC_MAX_BYTES;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return new TextDecoder().decode(bytes.subarray(start));
}

/** Run sizing the operator may override, absent where the controller's default applies. */
type RunSizing = Pick<
  RunSocietyWorkflowInput,
  "startupTimeoutMs" | "admissionTimeoutMs" | "cohortSize"
>;

interface PreparedRun {
  readonly path: string;
  readonly controllerImage: string;
  readonly supportImage: string;
  readonly applicationImage?: string;
  readonly runtimeCredentials?: Readonly<
    Partial<Record<"ANTHROPIC_API_KEY" | "OPENAI_API_KEY", string>>
  >;
  readonly executionProfile: KubernetesExecutionProfile;
  readonly sizing: RunSizing;
  readonly forceWorkerRoll: boolean;
  readonly connection: {
    readonly taskQueue: string;
    readonly temporalAddress: string;
    readonly temporalNamespace: string;
    readonly workerTemporalAddress?: string;
  };
}

function prepareRun(
  args: readonly string[],
  environment: RunEnvironment,
  executionProfile: KubernetesExecutionProfile,
): PreparedRun {
  const controllerImage = requiredImage(
    environment,
    "MOLTZAP_CONTROLLER_IMAGE",
  );
  // The worker runs inside the cluster and reaches Temporal over a different
  // endpoint than the operator does. Only a cluster whose Temporal is not the
  // one the local profile installs needs to say so.
  const workerTemporalAddress = optionalOverride(
    environment,
    "MOLTZAP_TEMPORAL_CLUSTER_ADDRESS",
  );
  return {
    path: experimentPath(args),
    controllerImage,
    executionProfile,
    // Exactly "1", so that an operator who exported the variable to something
    // else has not silently accepted losing a run.
    forceWorkerRoll: environment[FORCE_WORKER_ROLL_VARIABLE] === "1",
    sizing: runSizing(environment),
    supportImage: requiredImage(
      environment,
      "MOLTZAP_SUPPORT_IMAGE",
      controllerImage,
    ),
    applicationImage: optionalImage(environment, "MOLTZAP_APPLICATION_IMAGE"),
    runtimeCredentials: runtimeCredentials(environment),
    connection: {
      taskQueue: optionalNonEmpty(
        environment,
        "MOLTZAP_TEMPORAL_TASK_QUEUE",
        DEFAULT_LOCAL_TASK_QUEUE,
      ),
      temporalAddress: optionalNonEmpty(
        environment,
        "MOLTZAP_TEMPORAL_ADDRESS",
        DEFAULT_TEMPORAL_ADDRESS,
      ),
      temporalNamespace: optionalNonEmpty(
        environment,
        "MOLTZAP_TEMPORAL_NAMESPACE",
        DEFAULT_TEMPORAL_NAMESPACE,
      ),
      ...(workerTemporalAddress === undefined ? {} : { workerTemporalAddress }),
    },
  };
}

function requiredImage(
  environment: RunEnvironment,
  key: "MOLTZAP_CONTROLLER_IMAGE" | "MOLTZAP_SUPPORT_IMAGE",
  fallback?: string,
): string {
  const value = environment[key] ?? fallback;
  if (value === undefined || !DIGEST_PINNED_IMAGE.test(value)) {
    throw failure(
      "configuration",
      `${key} must be a lowercase SHA-256 digest-pinned image`,
    );
  }
  return value;
}

function optionalImage(
  environment: RunEnvironment,
  key: "MOLTZAP_APPLICATION_IMAGE",
): string | undefined {
  const value = environment[key];
  if (value === undefined) {
    return undefined;
  }
  if (!DIGEST_PINNED_IMAGE.test(value)) {
    throw failure(
      "configuration",
      `${key} must be a lowercase SHA-256 digest-pinned image`,
    );
  }
  return value;
}

function optionalNonEmpty(
  environment: RunEnvironment,
  key: string,
  fallback: string,
): string {
  const value = environment[key] ?? fallback;
  if (value.length === 0) {
    throw failure("configuration", `${key} must not be empty`);
  }
  return value;
}

function experimentPath(args: readonly string[]): string {
  const [entrypoint] = args;
  if (
    args.length !== 1 ||
    entrypoint === undefined ||
    !entrypoint.endsWith(".mjs")
  ) {
    throw failure("arguments", "expected exactly one .mjs RunSpec entrypoint");
  }
  return resolve(entrypoint);
}

function makeRunIdentity(uuid: string): {
  readonly runId: string;
  readonly namespace: string;
} {
  const compact = uuid.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(compact)) {
    throw failure("execution", "the local random identifier was invalid");
  }
  const namespace = `mz-${compact}`;
  return { runId: namespace, namespace };
}

function readExperiment(
  path: string,
  operations: SubmitOperationsService,
): Effect.Effect<string, RunSubmissionError> {
  return operations.readTextFile(path).pipe(
    // Which of a missing file, a directory, and a permission denial it was
    // reaches the operator only here: the reported detail is deliberately the
    // same sentence for all three.
    Effect.tapErrorCause(Effect.logError),
    Effect.mapError(() =>
      failure("module", "the RunSpec entrypoint could not be read"),
    ),
  );
}

// A refused worker roll is the operator's own next action rather than a fault
// in the run, so its text is reported instead of the generic detail. It names
// only images, run ids, and an environment variable; every other failure stays
// sanitized, because its detail can carry the connection the submitter used.
function submissionFailure(cause: Cause.UnknownException): RunSubmissionError {
  return cause.error instanceof RunWorkerRollRefused
    ? failure("configuration", cause.error.message)
    : failure("execution", "the Temporal-managed run did not complete");
}

function executeTemporalRun(
  options: RunTemporalSocietyOptions,
  operations: SubmitOperationsService,
): Effect.Effect<RunControllerResult, RunSubmissionError> {
  return Effect.tryPromise(() => operations.runTemporalSociety(options)).pipe(
    Effect.tapErrorCause(Effect.logError),
    Effect.mapError(submissionFailure),
  );
}

function runtimeCredentials(
  environment: RunEnvironment,
): PreparedRun["runtimeCredentials"] {
  const credentials = Object.fromEntries(
    (["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const).flatMap((key) => {
      const value = environment[key];
      return value === undefined || value.length === 0 ? [] : [[key, value]];
    }),
  );
  return Object.keys(credentials).length === 0
    ? undefined
    : Object.freeze(credentials);
}

function runSizing(environment: RunEnvironment): RunSizing {
  const startupTimeoutMs = countOverride(
    environment,
    "MOLTZAP_STARTUP_TIMEOUT_MS",
  );
  const admissionTimeoutMs = countOverride(
    environment,
    "MOLTZAP_ADMISSION_TIMEOUT_MS",
  );
  const cohortSize = countOverride(environment, "MOLTZAP_COHORT_SIZE");
  return {
    ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
    ...(admissionTimeoutMs === undefined ? {} : { admissionTimeoutMs }),
    ...(cohortSize === undefined ? {} : { cohortSize }),
  };
}

// Only what could never be a count. The bound each one carries belongs to the
// controller, so a value that is merely too large still reaches it.
function countOverride(
  environment: RunEnvironment,
  key: string,
): number | undefined {
  const encoded = optionalOverride(environment, key);
  if (encoded === undefined) {
    return undefined;
  }
  const value = Number(encoded);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw failure("configuration", `${key} must be a positive integer`);
  }
  return value;
}

function optionalOverride(
  environment: RunEnvironment,
  key: string,
): string | undefined {
  const value = environment[key];
  return value === undefined || value.length === 0 ? undefined : value;
}

// The value crossed Temporal and a worker this process does not own, so the
// bound is enforced here rather than trusted.
function boundedResult(result: RunControllerResult): RunControllerResult {
  if (result.exitCode === 0 || result.diagnostic === undefined) {
    return result;
  }
  return { ...result, diagnostic: boundedDiagnostic(result.diagnostic) };
}

function createRunIdentity(
  operations: SubmitOperationsService,
): Effect.Effect<ReturnType<typeof makeRunIdentity>, RunSubmissionError> {
  return Effect.try({
    try: () => makeRunIdentity(operations.randomUuid()),
    catch: (cause) =>
      cause instanceof RunSubmissionError
        ? cause
        : failure("execution", "the local run identity could not be created"),
  });
}

function executePreparedRun(
  prepared: PreparedRun,
  operations: SubmitOperationsService,
): Effect.Effect<RunSubmission, RunSubmissionError> {
  return Effect.gen(function* () {
    const identity = yield* createRunIdentity(operations);
    const experimentModule = yield* readExperiment(prepared.path, operations);
    const result = yield* executeTemporalRun(
      {
        executionProfile: prepared.executionProfile,
        forceWorkerRoll: prepared.forceWorkerRoll,
        workflowId: identity.runId,
        taskQueue: prepared.connection.taskQueue,
        temporalAddress: prepared.connection.temporalAddress,
        temporalNamespace: prepared.connection.temporalNamespace,
        ...(prepared.connection.workerTemporalAddress === undefined
          ? {}
          : {
              workerTemporalAddress: prepared.connection.workerTemporalAddress,
            }),
        input: {
          runId: identity.runId,
          namespace: identity.namespace,
          controllerImage: prepared.controllerImage,
          supportImage: prepared.supportImage,
          ...(prepared.applicationImage === undefined
            ? {}
            : { applicationImage: prepared.applicationImage }),
          ...(prepared.runtimeCredentials === undefined
            ? {}
            : { runtimeCredentials: prepared.runtimeCredentials }),
          experimentModule,
          ...prepared.sizing,
        },
      },
      operations,
    );
    return Object.freeze({ ...identity, result: boundedResult(result) });
  });
}

function failure(
  stage: RunSubmissionError["stage"],
  detail: string,
): RunSubmissionError {
  return new RunSubmissionError({ stage, detail });
}

/* eslint-enable agent-code-guard/promise-type -- Restore Effect-first contracts after the submission boundary. */
