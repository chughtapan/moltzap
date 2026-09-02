/** @file Non-deterministic Temporal boundary: activities, worker, client, submission. */

import { Context as ActivityContext } from "@temporalio/activity";
import { Client, Connection, type WorkflowClient } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Option,
  Runtime,
} from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The Temporal SDK owns this executable's Promise-native lifetime, including its Kubernetes readiness marker.
import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  CleanupRunInput,
  ControllerRunResult,
  RunLifecycleActivities,
  runSocietyWorkflow,
  RunSocietyWorkflowInput,
} from "./reclaim.js";
import { isEntryModule } from "./entry.js";
import {
  installRunWorker,
  type OpenRunReading,
  type RunWorkerInstallRequest,
} from "./install.js";
import {
  type KubernetesCallFailed,
  makeKubernetesRunWorkerInstallApi,
  type RunWorkerInstallApi,
} from "./kubernetes/calls.js";
import {
  IN_CLUSTER_TEMPORAL_ADDRESS,
  RUN_WORKER_READY_PATH,
} from "./kubernetes/objects.js";
import {
  decodeKubernetesExecutionProfile,
  type KubernetesExecutionProfile,
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
} from "./profile.js";
import {
  type ControllerObservation,
  makeKubernetesRunLifecycleOperations,
  type RunLifecycleOperations,
} from "./watch.js";

const WORKFLOW_TYPE = "runSocietyWorkflow";
const DEFAULT_TEMPORAL_NAMESPACE = "default";

/** Temporal-facing lifecycle contracts owned by cluster observation. */
export type { ControllerObservation, RunLifecycleOperations };

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
  /** Whether the operator accepted rolling the worker over its open runs. */
  readonly forceWorkerRoll?: boolean;
  /**
   * The submitter's own runtime, so what this boundary logs reaches the
   * logger the submitter configured rather than the default one.
   */
  readonly runtime?: Runtime.Runtime<never>;
}

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Temporal activities, workers, clients, and their host-operation dependencies are SDK-required Promise boundaries. */

/** Liveness signal proving the worker still owns the controller attempt. */
export type ControllerHeartbeat = () => void;

/** Host operations plus the liveness signal one worker attempt owns. */
export interface LifecycleOperationsService extends RunLifecycleOperations {
  /**
   * Bind a heartbeat to the activity running now, called where the SDK still
   * owns the ambient execution context. A heartbeat fiber resuming after a
   * timer no longer does, so it cannot resolve that context for itself, and an
   * implementation that resolves it per call throws there instead of
   * signalling. Required so that omitting it cannot compile.
   */
  readonly bindHeartbeat: () => ControllerHeartbeat;
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

// Comfortably inside the activity's heartbeat deadline in reclaim.ts.
const HEARTBEAT_INTERVAL = Duration.seconds(10);

class ControllerAttemptFailed extends Error {
  override readonly name = "ControllerAttemptFailed";
}

// eslint-disable-next-line agent-code-guard/max-non-trivial-classes-per-file -- a controller attempt that ended without a result and a worker started without its environment are the two ways this one SDK boundary refuses to proceed
class RunWorkerConfigurationFailed extends Error {
  override readonly name = "RunWorkerConfigurationFailed";
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
  await rm(RUN_WORKER_READY_PATH, { force: true });
  const connection = await NativeConnection.connect({
    address: required(environment, "MOLTZAP_TEMPORAL_ADDRESS"),
  });
  let worker: Worker | undefined;
  // #ignore-sloppy-code-next-line[promise-type]: Worker.run is an SDK Promise boundary retained so finally can await shutdown
  let running: Promise<void> | undefined;
  try {
    worker = await createRunSocietyWorker({
      connection,
      namespace: required(environment, "MOLTZAP_TEMPORAL_NAMESPACE"),
      taskQueue: required(environment, "MOLTZAP_TEMPORAL_TASK_QUEUE"),
      activities: workerActivities(environment),
    });
    running = worker.run();
    if (worker.getState() !== "RUNNING") {
      throw new RunWorkerConfigurationFailed(
        "the Temporal worker did not enter its polling state",
      );
    }
    await writeFile(RUN_WORKER_READY_PATH, "", { mode: 0o600 });
    await running;
  } finally {
    if (worker?.getState() === "RUNNING") {
      worker.shutdown();
    }
    await running?.catch(() => undefined);
    await rm(RUN_WORKER_READY_PATH, { force: true });
    await connection.close();
  }
}

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
    bindHeartbeat: () => {
      const activity = ActivityContext.current();
      return () => {
        activity.heartbeat();
      };
    },
  };
}

/**
 * Submit one run to the cluster's worker and wait for its controller result.
 *
 * The submitting process is only a Temporal client. A worker embedded here would
 * end with the process, stranding the workflow's cleanup and leaving the run's
 * namespace behind, so the queue is served by a Deployment that outlives any one
 * submission and that this call installs before submitting.
 *
 * The client connects first so that the install can be told what replacing the
 * worker would cost. Installing first makes that question unanswerable: by the
 * time anything could be asked, the Deployment is already rolling and the runs
 * the answer was about are already failing.
 *
 * @param options Temporal endpoint plus caller-owned workflow and run inputs.
 * @returns The successful controller activity result.
 */
// #ignore-sloppy-code-next-line[async-keyword]: Temporal workers, clients, and activities are SDK-required Promise boundaries
export async function runTemporalSociety(
  options: RunTemporalSocietyOptions,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal workers, clients, and activities are SDK-required Promise boundaries
): Promise<ControllerRunResult> {
  const namespace = options.temporalNamespace ?? DEFAULT_TEMPORAL_NAMESPACE;
  await runAtPromiseBoundary(
    Effect.logInfo("connecting Temporal"),
    options.runtime,
  );
  const connection = await Connection.connect(
    options.temporalAddress === undefined
      ? undefined
      : { address: options.temporalAddress },
  );
  try {
    const client = new Client({ connection, namespace });
    await runAtPromiseBoundary(
      installRunWorker(
        runWorkerInstallApi(options, namespace),
        installRequest(options, client.workflow),
      ),
      options.runtime,
    );
    await runAtPromiseBoundary(
      Effect.logInfo("starting workflow"),
      options.runtime,
    );
    return await executeRunSocietyWorkflow(options.input, {
      client: client.workflow,
      taskQueue: options.taskQueue,
      workflowId: options.workflowId,
    });
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
): Promise<ControllerRunResult> {
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
 * Read which runs the task queue has not finished yet.
 *
 * A queue that cannot be listed reads as unreadable rather than as empty. The
 * difference is the whole point: an empty answer clears a submission to replace
 * the worker, so a failed query that returned one would authorize exactly the
 * roll this reading exists to prevent.
 *
 * @param client Temporal client already connected to the run's namespace.
 * @param taskQueue Queue the cluster's worker serves.
 * @returns The open runs it named, or that it could not be asked.
 */
export function readOpenRuns(
  client: OpenRunLister,
  taskQueue: string,
): Effect.Effect<OpenRunReading> {
  return Effect.tryPromise(() => listOpenRunIds(client, taskQueue)).pipe(
    Effect.map(
      (workflowIds): OpenRunReading => ({ _tag: "open", workflowIds }),
    ),
    // Logged rather than reported: the cause names the connection the submitter
    // used, and operator-facing text is what the refusal already carries.
    Effect.tapErrorCause(Effect.logError),
    Effect.catchAll(() =>
      Effect.succeed<OpenRunReading>({ _tag: "unreadable" }),
    ),
  );
}

function runControllerOnce(
  operations: LifecycleOperationsService,
  heartbeat: ControllerHeartbeat,
  input: RunSocietyWorkflowInput,
): Effect.Effect<
  ControllerRunResult,
  ControllerAttemptFailed | KubernetesCallFailed
> {
  // Preparing a cohort outlasts the heartbeat deadline, so proof of life
  // cannot depend on reaching the observation loop.
  return Effect.scoped(
    Effect.gen(function* () {
      const beat = Effect.sync(heartbeat);
      yield* beat;
      yield* Effect.forkScoped(
        Effect.sleep(HEARTBEAT_INTERVAL).pipe(
          // A signal that throws must cost one beat, not the rest of the
          // attempt: an unrecovered failure ends the loop and starves the
          // deadline exactly as the missing signal did.
          Effect.zipRight(beat.pipe(Effect.tapErrorCause(Effect.logError))),
          Effect.ignore,
          Effect.forever,
        ),
      );
      yield* operations.prepareRun(input);
      for (;;) {
        const observation = yield* operations.observeController(input);
        switch (observation._tag) {
          case "completed":
            return observation.result;
          case "failed":
            return yield* Effect.fail(
              new ControllerAttemptFailed(observation.detail),
            );
          case "running":
            yield* operations.waitBeforeObservation();
            break;
          default:
            return yield* Effect.fail(
              new ControllerAttemptFailed(
                "controller returned an unsupported observation",
              ),
            );
        }
      }
    }),
  );
}

function cleanupRun(
  operations: LifecycleOperationsService,
  input: CleanupRunInput,
): Effect.Effect<void, KubernetesCallFailed> {
  return Effect.gen(function* () {
    yield* operations.deleteRunNamespace(input.namespace);
    while (yield* operations.runNamespaceExists(input.namespace)) {
      yield* operations.waitBeforeObservation();
    }
  });
}

/**
 * Run one Effect where an SDK owns a Promise-returning signature.
 *
 * This is the only place a run's Effect becomes a Promise. Rejecting with the
 * run's own failure rather than the runtime's wrapper is what lets Temporal
 * record the error the activity actually produced. The caller passes its own
 * runtime when it has one, so what the boundary logs reaches the logger that
 * caller configured; otherwise the default runtime applies.
 */
// #ignore-sloppy-code-next-line[async-keyword]: Temporal workers, clients, and activities are SDK-required Promise boundaries
async function runAtPromiseBoundary<Result, Failure extends Error>(
  effect: Effect.Effect<Result, Failure>,
  runtime?: Runtime.Runtime<never>,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal workers, clients, and activities are SDK-required Promise boundaries
): Promise<Result> {
  const exit = await Runtime.runPromiseExit(runtime ?? Runtime.defaultRuntime)(
    effect,
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Option.getOrElse(Cause.failureOption(exit.cause), () =>
    Runtime.makeFiberFailure(exit.cause),
  );
}

/** The two activities the coarse workflow worker registers. */
export const runLifecycleActivities: Effect.Effect<
  RunLifecycleActivities,
  never,
  LifecycleOperations
> = Effect.map(LifecycleOperations, (operations) =>
  Object.freeze({
    runControllerOnce: (input: RunSocietyWorkflowInput) =>
      runAtPromiseBoundary(
        runControllerOnce(operations, operations.bindHeartbeat(), input),
      ),
    cleanupRun: (input: CleanupRunInput) =>
      runAtPromiseBoundary(cleanupRun(operations, input)),
  }),
);

// The SDK takes a plain activity record, so the environment is resolved here
// rather than carried into the worker's Promise-native lifetime.
function workerActivities(
  environment: RunWorkerEnvironment,
): RunLifecycleActivities {
  return Effect.runSync(
    runLifecycleActivities.pipe(
      Effect.provideService(
        LifecycleOperations,
        kubernetesLifecycleOperations(workerProfile(environment)),
      ),
    ),
  );
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

/** The most open runs one reading names before it stops counting. */
const OPEN_RUN_SAMPLE = 20;

/** Visibility-query clause matching a run its task queue has not finished. */
export const OPEN_RUN_FILTER = "ExecutionStatus = 'Running'";

/**
 * The exact listing surface reading a queue's unfinished work needs.
 *
 * Narrower than the client's own, so that what this reads is the whole of what
 * it depends on and a test can supply it without standing up a Temporal server.
 */
export interface OpenRunLister {
  readonly list: (options: {
    readonly query: string;
  }) => AsyncIterable<{ readonly workflowId: string }>;
}

// Bounded, because the caller only has to know that some run is still open and
// which ones to name; an unbounded listing walks every page of the visibility
// store to answer a question the first page already answered.
// #ignore-sloppy-code-next-line[async-keyword]: Temporal workers, clients, and activities are SDK-required Promise boundaries
async function listOpenRunIds(
  client: OpenRunLister,
  taskQueue: string,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal workers, clients, and activities are SDK-required Promise boundaries
): Promise<readonly string[]> {
  const workflowIds: string[] = [];
  for await (const execution of client.list({
    query: `TaskQueue = ${queryLiteral(taskQueue)} AND ${OPEN_RUN_FILTER}`,
  })) {
    workflowIds.push(execution.workflowId);
    if (workflowIds.length >= OPEN_RUN_SAMPLE) {
      break;
    }
  }
  return workflowIds;
}

/**
 * One operator-supplied value as a visibility-query string literal.
 * @param value Value the query compares a field against.
 * @returns The quoted literal, with any quote inside it doubled.
 */
function queryLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function installRequest(
  options: RunTemporalSocietyOptions,
  client: OpenRunLister,
): RunWorkerInstallRequest {
  return {
    desiredImage: options.input.controllerImage,
    readOpenRuns: () => readOpenRuns(client, options.taskQueue),
    forced: options.forceWorkerRoll ?? false,
  };
}

function runWorkerInstallApi(
  options: RunTemporalSocietyOptions,
  namespace: string,
): RunWorkerInstallApi {
  return makeKubernetesRunWorkerInstallApi({
    controllerImage: options.input.controllerImage,
    taskQueue: options.taskQueue,
    temporalAddress:
      options.workerTemporalAddress ?? IN_CLUSTER_TEMPORAL_ADDRESS,
    temporalNamespace: namespace,
    profile: options.executionProfile ?? LOCAL_KUBERNETES_EXECUTION_PROFILE,
  });
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
