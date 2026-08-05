/* eslint-disable agent-code-guard/promise-type -- File loading and the Temporal SDK are Promise-native at this submission boundary. */
/** @file Shared submission of one experiment to a Temporal-managed cluster. */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Context, Data, Effect, Layer } from "effect";
import type { KubernetesExecutionProfile } from "./profile.js";
import type { RunControllerResult } from "./reclaim.js";
import {
  runTemporalSociety,
  type RunTemporalSocietyOptions,
} from "./temporal.js";

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

/** Successful submission reported to the operator. */
export interface RunSubmission {
  readonly runId: string;
  readonly namespace: string;
  readonly result: RunControllerResult;
}

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

function failure(
  stage: RunSubmissionError["stage"],
  detail: string,
): RunSubmissionError {
  return new RunSubmissionError({ stage, detail });
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

function optionalOverride(
  environment: RunEnvironment,
  key: string,
): string | undefined {
  const value = environment[key];
  return value === undefined || value.length === 0 ? undefined : value;
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
  return operations
    .readTextFile(path)
    .pipe(
      Effect.mapError(() =>
        failure("module", "the RunSpec entrypoint could not be read"),
      ),
    );
}

function executeTemporalRun(
  options: RunTemporalSocietyOptions,
  operations: SubmitOperationsService,
): Effect.Effect<RunControllerResult, RunSubmissionError> {
  return Effect.tryPromise({
    try: () => operations.runTemporalSociety(options),
    catch: () =>
      failure("execution", "the Temporal-managed run did not complete"),
  });
}

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

interface PreparedRun {
  readonly path: string;
  readonly controllerImage: string;
  readonly supportImage: string;
  readonly runtimeCredentials?: Readonly<
    Partial<Record<"ANTHROPIC_API_KEY" | "OPENAI_API_KEY", string>>
  >;
  readonly executionProfile: KubernetesExecutionProfile;
  readonly connection: {
    readonly taskQueue: string;
    readonly temporalAddress: string;
    readonly temporalNamespace: string;
    readonly workerTemporalAddress?: string;
  };
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
    supportImage: requiredImage(
      environment,
      "MOLTZAP_SUPPORT_IMAGE",
      controllerImage,
    ),
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

function executePreparedRun(
  prepared: PreparedRun,
  operations: SubmitOperationsService,
): Effect.Effect<RunSubmission, RunSubmissionError> {
  return Effect.gen(function* () {
    const identity = yield* Effect.try({
      try: () => makeRunIdentity(operations.randomUuid()),
      catch: (cause) =>
        cause instanceof RunSubmissionError
          ? cause
          : failure("execution", "the local run identity could not be created"),
    });
    const experimentModule = yield* readExperiment(prepared.path, operations);
    const result = yield* executeTemporalRun(
      {
        executionProfile: prepared.executionProfile,
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
          ...(prepared.runtimeCredentials === undefined
            ? {}
            : { runtimeCredentials: prepared.runtimeCredentials }),
          experimentModule,
        },
      },
      operations,
    );
    return Object.freeze({ ...identity, result });
  });
}

/* eslint-enable agent-code-guard/promise-type -- Restore Effect-first contracts after the submission boundary. */
