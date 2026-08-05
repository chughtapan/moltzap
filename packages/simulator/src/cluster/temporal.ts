/** @file Non-deterministic Temporal boundary: activities, worker, client, submission. */

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Entry-point detection runs at module load, before any Effect runtime exists to provide FileSystem.
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context as ActivityContext } from "@temporalio/activity";
import { Client, Connection, type WorkflowClient } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Context, Effect } from "effect";
import type {
  CleanupRunInput,
  RunControllerResult,
  RunLifecycleActivities,
  RunSocietyWorkflowInput,
  runSocietyWorkflow,
} from "./reclaim.js";
import { installRunWorker } from "./install.js";
import { makeKubernetesRunWorkerInstallApi } from "./kubernetes/calls.js";
import { IN_CLUSTER_TEMPORAL_ADDRESS } from "./kubernetes/objects.js";
import {
  decodeKubernetesExecutionProfile,
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
  type KubernetesExecutionProfile,
} from "./profile.js";
import { makeKubernetesRunLifecycleOperations } from "./watch.js";

const WORKFLOW_TYPE = "runSocietyWorkflow";
const FILE_URL_SCHEME = "file:";
const DEFAULT_TEMPORAL_NAMESPACE = "default";

/** Coarse controller state observed by the host-side activity. */
export type ControllerObservation =
  | { readonly _tag: "running" }
  | {
      readonly _tag: "succeeded";
      readonly result: RunControllerResult;
    }
  | {
      readonly _tag: "failed";
      readonly detail: string;
      readonly result?: RunControllerResult;
    };

/** Process environment read by the in-cluster worker Deployment. */
export type RunWorkerEnvironment = Readonly<Record<string, string | undefined>>;

/** Caller-owned identity and queue for a single workflow execution. */
export interface RunSocietyWorkflowExecutionOptions {
  readonly client: Pick<WorkflowClient, "execute">;
  readonly workflowId: string;
  readonly taskQueue: string;
}

/** Host profile inputs for one workflow, with identity selected by the caller. */
export interface RunTemporalSocietyOptions {
  readonly input: RunSocietyWorkflowInput;
  readonly executionProfile?: KubernetesExecutionProfile;
  readonly workflowId: string;
  readonly taskQueue: string;
  readonly temporalAddress?: string;
  readonly temporalNamespace?: string;
  /** Temporal endpoint as the in-cluster worker reaches it, not as the host does. */
  readonly workerTemporalAddress?: string;
}

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Temporal activities, workers, clients, and their host-operation dependencies are SDK-required Promise boundaries. */

/** Liveness signal proving the worker still owns the controller attempt. */
export type ControllerHeartbeat = () => void;

/** Injectable host operations kept outside deterministic workflow code. */
export interface RunLifecycleOperations {
  readonly prepareRun: (input: RunSocietyWorkflowInput) => Promise<void>;
  readonly observeController: (
    input: RunSocietyWorkflowInput,
  ) => Promise<ControllerObservation>;
  readonly deleteRunNamespace: (namespace: string) => Promise<void>;
  readonly runNamespaceExists: (namespace: string) => Promise<boolean>;
  readonly waitBeforeObservation: () => Promise<void>;
}

/** Host operations plus the liveness signal one worker attempt owns. */
export interface LifecycleOperationsService extends RunLifecycleOperations {
  readonly heartbeat: ControllerHeartbeat;
}

/** Lifecycle boundaries the worker's activities read from their environment. */
export class LifecycleOperations extends Context.Tag(
  "@moltzap/simulator/LifecycleOperations",
)<LifecycleOperations, LifecycleOperationsService>() {}

/** SDK objects needed to build a worker without selecting connection policy. */
interface RunSocietyWorkerOptions {
  readonly connection: NativeConnection;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly activities: RunLifecycleActivities;
}

class ControllerAttemptFailed extends Error {
  override readonly name = "ControllerAttemptFailed";
}

// eslint-disable-next-line agent-code-guard/max-non-trivial-classes-per-file -- a controller attempt that ended without a result and a worker started without its environment are the two ways this one SDK boundary refuses to proceed
class RunWorkerConfigurationFailed extends Error {
  override readonly name = "RunWorkerConfigurationFailed";
}

// #ignore-sloppy-code-next-line[async-keyword]: Temporal workers, clients, and activities are SDK-required Promise boundaries
async function runControllerOnce(
  operations: LifecycleOperationsService,
  input: RunSocietyWorkflowInput,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal workers, clients, and activities are SDK-required Promise boundaries
): Promise<RunControllerResult> {
  await operations.prepareRun(input);
  for (;;) {
    // Every observation is also the attempt's proof of life. Without it the
    // workflow cannot tell a controller that is still working from a worker
    // that stopped, and the run's namespace survives until the far longer
    // start-to-close deadline expires.
    operations.heartbeat();
    const observation = await operations.observeController(input);
    switch (observation._tag) {
      case "succeeded":
        return observation.result;
      case "failed":
        if (observation.result !== undefined) {
          return observation.result;
        }
        throw new ControllerAttemptFailed(observation.detail);
      case "running":
        await operations.waitBeforeObservation();
        break;
      default:
        throw new ControllerAttemptFailed(
          "controller returned an unsupported observation",
        );
    }
  }
}

// #ignore-sloppy-code-next-line[async-keyword]: Temporal workers, clients, and activities are SDK-required Promise boundaries
async function cleanupRun(
  operations: LifecycleOperationsService,
  input: CleanupRunInput,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal workers, clients, and activities are SDK-required Promise boundaries
): Promise<void> {
  await operations.deleteRunNamespace(input.namespace);
  while (await operations.runNamespaceExists(input.namespace)) {
    await operations.waitBeforeObservation();
  }
}

/** The two activities the coarse workflow worker registers. */
export const runLifecycleActivities: Effect.Effect<
  RunLifecycleActivities,
  never,
  LifecycleOperations
> = Effect.map(LifecycleOperations, (operations) =>
  Object.freeze({
    runControllerOnce: (input: RunSocietyWorkflowInput) =>
      runControllerOnce(operations, input),
    cleanupRun: (input: CleanupRunInput) => cleanupRun(operations, input),
  }),
);

/**
 * Bind the worker Pod's Kubernetes access and Temporal heartbeat.
 * @param profile Private local or GKE cluster selected by the host.
 * @returns Lifecycle operations backed by the worker Pod's service account.
 */
export function kubernetesLifecycleOperations(
  profile: KubernetesExecutionProfile = LOCAL_KUBERNETES_EXECUTION_PROFILE,
): LifecycleOperationsService {
  return {
    ...makeKubernetesRunLifecycleOperations(profile),
    heartbeat: () => {
      ActivityContext.current().heartbeat();
    },
  };
}

/**
 * Create a worker that registers only the coarse workflow and its two activities.
 * @param options Existing connection, namespace, queue, and activity implementations.
 * @returns A worker ready to poll the selected task queue.
 */
// #ignore-sloppy-code-next-line[async-keyword]: Temporal workers, clients, and activities are SDK-required Promise boundaries
async function createRunSocietyWorker(
  options: RunSocietyWorkerOptions,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal workers, clients, and activities are SDK-required Promise boundaries
): Promise<Worker> {
  return await Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    activities: options.activities,
    workflowsPath: fileURLToPath(new URL("./reclaim.js", import.meta.url)),
  });
}

function required(environment: RunWorkerEnvironment, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) {
    throw new RunWorkerConfigurationFailed(`${key} is required by the worker`);
  }
  return value;
}

function workerProfile(
  environment: RunWorkerEnvironment,
): KubernetesExecutionProfile {
  const encoded = environment.MOLTZAP_EXECUTION_PROFILE;
  return encoded === undefined || encoded.length === 0
    ? LOCAL_KUBERNETES_EXECUTION_PROFILE
    : decodeKubernetesExecutionProfile(encoded);
}

/**
 * Poll the run-lifecycle task queue until the process is shut down.
 *
 * This is the only place a worker runs. Serving the queue from a submitting
 * process would tie a run's cleanup to whichever host started it, and a host
 * that goes away leaves the run's namespace behind.
 *
 * @param environment Temporal endpoint, queue, and cluster profile.
 * @returns Nothing once the worker has shut down and released its connection.
 */
// #ignore-sloppy-code-next-line[async-keyword]: Temporal workers, clients, and activities are SDK-required Promise boundaries
export async function serveRunSocietyWorker(
  environment: RunWorkerEnvironment,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal workers, clients, and activities are SDK-required Promise boundaries
): Promise<void> {
  const connection = await NativeConnection.connect({
    address: required(environment, "MOLTZAP_TEMPORAL_ADDRESS"),
  });
  try {
    const worker = await createRunSocietyWorker({
      connection,
      namespace: required(environment, "MOLTZAP_TEMPORAL_NAMESPACE"),
      taskQueue: required(environment, "MOLTZAP_TEMPORAL_TASK_QUEUE"),
      // The SDK takes a plain activity record, so the environment is resolved
      // here rather than carried into the worker's Promise-native lifetime.
      activities: Effect.runSync(
        runLifecycleActivities.pipe(
          Effect.provideService(
            LifecycleOperations,
            kubernetesLifecycleOperations(workerProfile(environment)),
          ),
        ),
      ),
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

/**
 * Start exactly one workflow execution and wait for its controller result.
 * @param input Serializable controller input carried by the workflow.
 * @param options Caller-selected Temporal client, identity, and task queue.
 * @returns The successful controller activity result.
 */
// #ignore-sloppy-code-next-line[async-keyword]: Temporal workers, clients, and activities are SDK-required Promise boundaries
export async function executeRunSocietyWorkflow(
  input: RunSocietyWorkflowInput,
  options: RunSocietyWorkflowExecutionOptions,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal workers, clients, and activities are SDK-required Promise boundaries
): Promise<RunControllerResult> {
  return await options.client.execute<typeof runSocietyWorkflow>(
    WORKFLOW_TYPE,
    {
      workflowId: options.workflowId,
      taskQueue: options.taskQueue,
      args: [input],
    },
  );
}

/**
 * Submit one run to the cluster's worker and wait for its controller result.
 *
 * The submitting process is only a Temporal client. A worker embedded here would
 * end with the process, stranding the workflow's cleanup and leaving the run's
 * namespace behind, so the queue is served by a Deployment that outlives any one
 * submission and that this call installs before submitting.
 *
 * @param options Temporal endpoint plus caller-owned workflow and run inputs.
 * @returns The successful controller activity result.
 */
// #ignore-sloppy-code-next-line[async-keyword]: Temporal workers, clients, and activities are SDK-required Promise boundaries
export async function runTemporalSociety(
  options: RunTemporalSocietyOptions,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal workers, clients, and activities are SDK-required Promise boundaries
): Promise<RunControllerResult> {
  const namespace = options.temporalNamespace ?? DEFAULT_TEMPORAL_NAMESPACE;
  await installRunWorker(
    makeKubernetesRunWorkerInstallApi({
      controllerImage: options.input.controllerImage,
      taskQueue: options.taskQueue,
      temporalAddress:
        options.workerTemporalAddress ?? IN_CLUSTER_TEMPORAL_ADDRESS,
      temporalNamespace: namespace,
      profile: options.executionProfile ?? LOCAL_KUBERNETES_EXECUTION_PROFILE,
    }),
  );
  const connection = await Connection.connect(
    options.temporalAddress === undefined
      ? undefined
      : { address: options.temporalAddress },
  );
  try {
    const client = new Client({ connection, namespace });
    return await executeRunSocietyWorkflow(options.input, {
      client: client.workflow,
      taskQueue: options.taskQueue,
      workflowId: options.workflowId,
    });
  } finally {
    await connection.close();
  }
}

function realPath(path: string): string | undefined {
  return existsSync(path) ? realpathSync(path) : undefined;
}

/**
 * Whether a module is the process entry point rather than an ordinary import.
 *
 * Both sides are canonicalized because they are not the same kind of path:
 * Node resolves a module's real path before it becomes `import.meta.url`, while
 * `process.argv[1]` is whatever the caller typed. An image that reaches the
 * worker through a symlinked directory would otherwise look like an import, and
 * the worker would exit without ever serving the run-lifecycle task queue.
 *
 * @param moduleUrl URL of the module asking whether it was invoked directly.
 * @param invoked Path the process was started with, if it has one.
 * @returns Whether both locations name the same real file.
 */
export function isEntryModule(moduleUrl: string, invoked?: string): boolean {
  if (invoked === undefined || invoked.length === 0) {
    return false;
  }
  if (!moduleUrl.startsWith(FILE_URL_SCHEME)) {
    return false;
  }
  const entry = realPath(resolve(invoked));
  return entry !== undefined && entry === realPath(fileURLToPath(moduleUrl));
}

function isDirectInvocation(): boolean {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Direct-entry detection has no Effect Platform equivalent.
  return isEntryModule(import.meta.url, process.argv[1]);
}

if (isDirectInvocation()) {
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- The executable boundary injects the environment into the typed worker configuration.
  await serveRunSocietyWorker(process.env);
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first application rules after the Temporal boundary. */
