/* eslint-disable agent-code-guard/promise-type -- File loading and the Temporal SDK are Promise-native at this executable boundary. */
/** @file Repository-local entry point for one Temporal-managed Kubernetes run. */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FileSystem } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Data, Effect } from "effect";
import {
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
  type KubernetesExecutionProfile,
} from "../kubernetes/profile.js";
import type { RunControllerResult } from "../temporal/contract.js";
import {
  runTemporalSociety,
  type RunTemporalSocietyOptions,
} from "../temporal/run.js";

/** Temporal queue used by the repository-owned local profile. */
export const DEFAULT_LOCAL_TASK_QUEUE = "moltzap-simulator";
const DEFAULT_TEMPORAL_ADDRESS = "127.0.0.1:7233";
const DEFAULT_TEMPORAL_NAMESPACE = "default";
const DIGEST_PINNED_IMAGE = /^.+@sha256:[0-9a-f]{64}$/u;

/** Process environment read by the private local profile. */
export type LocalRunEnvironment = Readonly<Record<string, string | undefined>>;

/** Stable stage labels used by the sanitized local failure. */
export const LOCAL_RUN_STAGE = Object.freeze({
  arguments: "arguments",
  configuration: "configuration",
  module: "module",
  execution: "execution",
} as const);

/** Injectable native operations used by deterministic entry-point tests. */
export interface LocalRunOperations {
  readonly readExperimentModule: (
    path: string,
  ) => Effect.Effect<string, unknown>;
  readonly randomUuid: () => string;
  readonly runTemporalSociety: (
    options: RunTemporalSocietyOptions,
  ) => Promise<RunControllerResult>;
}

/** Successful local invocation reported to the operator. */
export interface LocalRunResult {
  readonly runId: string;
  readonly namespace: string;
  readonly result: RunControllerResult;
}

/** Sanitized failure at the repository-owned submission boundary. */
export class LocalRunFailed extends Data.TaggedError("LocalRunFailed")<{
  readonly stage: "arguments" | "configuration" | "module" | "execution";
  readonly detail: string;
}> {
  override get message(): string {
    return `Simulator ${this.stage} failed: ${this.detail}`;
  }
}

const liveOperations: LocalRunOperations = Object.freeze({
  readExperimentModule: (path: string) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
      Effect.provide(NodeContext.layer),
    ),
  randomUuid: randomUUID,
  runTemporalSociety,
});

function failure(
  stage: LocalRunFailed["stage"],
  detail: string,
): LocalRunFailed {
  return new LocalRunFailed({ stage, detail });
}

function requiredImage(
  environment: LocalRunEnvironment,
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
  environment: LocalRunEnvironment,
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
  operations: LocalRunOperations,
): Effect.Effect<string, LocalRunFailed> {
  return operations
    .readExperimentModule(path)
    .pipe(
      Effect.mapError(() =>
        failure("module", "the RunSpec entrypoint could not be read"),
      ),
    );
}

function executeTemporalRun(
  options: RunTemporalSocietyOptions,
  operations: LocalRunOperations,
): Effect.Effect<RunControllerResult, LocalRunFailed> {
  return Effect.tryPromise({
    try: () => operations.runTemporalSociety(options),
    catch: () =>
      failure("execution", "the Temporal-managed run did not complete"),
  });
}

/**
 * Submit one mounted experiment through the core Kubernetes execution path.
 * @param args One repository-local `.mjs` RunSpec path.
 * @param environment Local profile connection and image configuration.
 * @param operations Native boundaries, replaceable only by tests.
 * @returns The coarse workflow result and ephemeral run identity.
 */
export function runLocalSocietyWith(
  args: readonly string[],
  environment: LocalRunEnvironment,
  operations: LocalRunOperations,
): Effect.Effect<LocalRunResult, LocalRunFailed> {
  return runKubernetesSocietyWith(
    args,
    environment,
    LOCAL_KUBERNETES_EXECUTION_PROFILE,
    operations,
  );
}

/**
 * Submit through the shared Kubernetes path with one private host profile.
 * @param args One repository-local `.mjs` RunSpec path.
 * @param environment Image and Temporal connection configuration.
 * @param executionProfile Host-owned Kubernetes infrastructure selection.
 * @param operations Native boundaries, replaceable only by tests.
 * @returns The coarse workflow result and ephemeral run identity.
 */
export function runKubernetesSocietyWith(
  args: readonly string[],
  environment: LocalRunEnvironment,
  executionProfile: KubernetesExecutionProfile,
  operations: LocalRunOperations,
): Effect.Effect<LocalRunResult, LocalRunFailed> {
  return Effect.try({
    try: () => prepareLocalRun(args, environment, executionProfile),
    catch: (cause) =>
      cause instanceof LocalRunFailed
        ? cause
        : failure("configuration", "the run configuration was invalid"),
  }).pipe(
    Effect.flatMap((prepared) => executePreparedLocalRun(prepared, operations)),
    Effect.withSpan("runKubernetesSocietyWith"),
  );
}

interface PreparedLocalRun {
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
  };
}

function runtimeCredentials(
  environment: LocalRunEnvironment,
): PreparedLocalRun["runtimeCredentials"] {
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

function prepareLocalRun(
  args: readonly string[],
  environment: LocalRunEnvironment,
  executionProfile: KubernetesExecutionProfile,
): PreparedLocalRun {
  const controllerImage = requiredImage(
    environment,
    "MOLTZAP_CONTROLLER_IMAGE",
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
    },
  };
}

function executePreparedLocalRun(
  prepared: PreparedLocalRun,
  operations: LocalRunOperations,
): Effect.Effect<LocalRunResult, LocalRunFailed> {
  return Effect.gen(function* () {
    const identity = yield* Effect.try({
      try: () => makeRunIdentity(operations.randomUuid()),
      catch: (cause) =>
        cause instanceof LocalRunFailed
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

/**
 * Run one repository-local experiment against the configured local profile.
 * @param args One `.mjs` RunSpec entrypoint.
 * @param environment Local image and Temporal settings.
 * @returns The coarse run result and ephemeral run identity.
 */
function runLocalSociety(
  args: readonly string[],
  environment: LocalRunEnvironment,
): Effect.Effect<LocalRunResult, LocalRunFailed> {
  return runLocalSocietyWith(args, environment, liveOperations);
}

/**
 * Run one repository-owned experiment with an already validated profile.
 * @param args One `.mjs` RunSpec entrypoint.
 * @param environment Digest-pinned image and Temporal settings.
 * @param executionProfile Private Kubernetes infrastructure selection.
 * @returns The coarse run result and ephemeral run identity.
 */
export function runKubernetesSociety(
  args: readonly string[],
  environment: LocalRunEnvironment,
  executionProfile: KubernetesExecutionProfile,
): Effect.Effect<LocalRunResult, LocalRunFailed> {
  return runKubernetesSocietyWith(
    args,
    environment,
    executionProfile,
    liveOperations,
  );
}

function isDirectInvocation(): boolean {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Direct-entry detection has no Effect Platform equivalent.
  const invoked = process.argv[1];
  return (
    invoked !== undefined &&
    pathToFileURL(resolve(invoked)).href === import.meta.url
  );
}

if (isDirectInvocation()) {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The executable boundary captures argv once before entering Effect.
  const args = process.argv.slice(2);
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- The executable boundary injects the environment into the typed local configuration.
  const environment = process.env;
  runLocalSociety(args, environment).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }),
    ),
    NodeRuntime.runMain,
  );
}

/* eslint-enable agent-code-guard/promise-type -- Restore Effect-first contracts after the executable boundary. */
