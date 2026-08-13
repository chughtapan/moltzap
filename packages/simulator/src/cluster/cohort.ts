/** @file Private Kubernetes realization of one complete simulator society. */
// safer-arch-ignore no-cross-domain-sibling-import: Bringing a roster up is inherently cross-domain: it renders agents and reserves cluster capacity.

import { posix } from "node:path";
import {
  Deferred,
  Duration,
  Effect,
  Layer,
  Schedule,
  type Scope,
} from "effect";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  RuntimeGatewayOf,
} from "../agents/roster.js";
import {
  RuntimeExited,
  RuntimeFailed,
  RuntimeSignaled,
  type AgentRuntimeLike,
  type RunningAgent,
  type RuntimeTermination,
} from "../agents/agent.js";
import {
  containerRuntimeFor,
  type Application,
  type ContainerRuntime,
  type CredentialName,
  type File,
  type Image,
  type Resources,
} from "../agents/container.js";
import {
  Cluster,
  type Slot,
  type ClusterService,
  type Society,
  ClusterError,
} from "./cluster.js";
import {
  currentConditionIsTrue,
  type KubernetesSocietyApi,
  type PodObservation,
  type SandboxObservation,
} from "./kubernetes/calls.js";
import {
  aggregateWorkloadManifest,
  bootstrapSecretManifest,
  type KubernetesRunOwner,
  type ReservedCapacity,
  type RuntimeCapacitySlot,
  type SandboxApplication,
  sandboxManifest,
} from "./kubernetes/objects.js";
import type { KubernetesPodPlacement } from "./profile.js";

const WORKLOAD_NAME = "society";
const APPLICATION_CONTAINER_NAME = "application";
const BOOTSTRAP_ROOT = "/var/run/moltzap/bootstrap/";

/**
 * Admission and readiness hold the run at its starting line, so they are
 * observed at the rate someone waits at.
 */
const DEFAULT_READINESS_INTERVAL = Duration.millis(250);

/**
 * Liveness only has to notice an ending. Every agent and the reservation
 * observe it for the whole run rather than for a startup window, and each
 * observation is a quorum read of the cluster's own store, so the run's
 * standing cost is this interval divided into the roster.
 */
const DEFAULT_LIVENESS_INTERVAL = Duration.seconds(5);

interface TerminatedApplication {
  readonly exitCode: number;
  readonly signal?: number;
  readonly reason?: string;
  readonly message?: string;
}

/** Run-scoped facts every observation of one prepared roster shares. */
interface KubernetesSession {
  readonly options: KubernetesClusterOptions;
  readonly readinessInterval: Duration.Duration;
  readonly livenessInterval: Duration.Duration;
  /** Carries an acquired Sandbox that vanished into the session's failure. */
  readonly lost: Deferred.Deferred<never, ClusterError>;
}

interface KubernetesSessionState<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> extends KubernetesSession {
  /** Roster entries whose Sandbox reached readiness and attached. */
  readonly acquired: Set<string>;
  readonly resourceNames: Readonly<
    Record<Extract<keyof Definitions, string>, string>
  >;
}

/** Inputs already owned by the run controller and hidden from customer code. */
export interface KubernetesClusterOptions {
  readonly api: KubernetesSocietyApi;
  readonly namespace: string;
  readonly queueName: string;
  readonly owner: KubernetesRunOwner;
  readonly supportImage: Image;
  /** Fixed provider credentials used only by model-configured applications. */
  readonly runtimeCredentials?: Readonly<
    Partial<Record<CredentialName, string>>
  >;
  readonly rosterPlacement?: KubernetesPodPlacement;
  readonly startupTimeout: Duration.Duration;
  /** How often admission and readiness are observed while the run starts. */
  readonly readinessInterval?: Duration.Duration;
  /** How often a running agent and the reservation are observed to still be there. */
  readonly livenessInterval?: Duration.Duration;
}

function clusterError(detail: string): ClusterError {
  return new ClusterError({ detail });
}

function resourceRequests(
  resources: Resources,
): Readonly<Record<string, string>> {
  return {
    cpu: `${String(resources.cpuMillis)}m`,
    memory: String(resources.memoryBytes),
    "ephemeral-storage": String(resources.ephemeralStorageBytes),
  };
}

function agentResourceName(index: number, name: string): string {
  return `agent-${String(index + 1)}-${name.replaceAll("_", "-")}`;
}

function positiveConditionDetail(
  observation: SandboxObservation,
  type: string,
): string | undefined {
  const generation = observation.metadata.generation;
  const condition = observation.status?.conditions?.find(
    (entry) =>
      entry.type === type &&
      entry.status === "True" &&
      (generation === undefined || entry.observedGeneration === generation),
  );
  return condition === undefined
    ? undefined
    : [condition.reason, condition.message].filter(Boolean).join(": ");
}

function workloadAdmission(
  api: KubernetesSocietyApi,
  within: Duration.Duration,
  readinessInterval: Duration.Duration,
): Effect.Effect<void, ClusterError> {
  const observe: Effect.Effect<void, ClusterError> = Effect.suspend(() =>
    api.readWorkload(WORKLOAD_NAME).pipe(
      Effect.flatMap((workload) => {
        if (workload.metadata.deletionTimestamp !== undefined) {
          return Effect.fail(
            clusterError(
              "aggregate capacity reservation was deleted before admission",
            ),
          );
        }
        if (currentConditionIsTrue(workload, "Evicted")) {
          return Effect.fail(
            clusterError(
              "aggregate capacity reservation was evicted before admission",
            ),
          );
        }
        return currentConditionIsTrue(workload, "Admitted") &&
          workload.status?.admission !== undefined
          ? Effect.void
          : Effect.sleep(readinessInterval).pipe(Effect.zipRight(observe));
      }),
    ),
  );
  return observe.pipe(
    Effect.timeoutFail({
      duration: within,
      onTimeout: () =>
        clusterError(
          `complete roster was not admitted within ${Duration.format(within)}`,
        ),
    }),
  );
}

function applicationTerminated(
  pod: PodObservation,
): TerminatedApplication | undefined {
  return pod.status?.containerStatuses?.find(
    (entry) => entry.name === APPLICATION_CONTAINER_NAME,
  )?.state.terminated;
}

function liveApplicationPod(
  pods: readonly PodObservation[],
): PodObservation | undefined {
  const live = pods.filter(
    (pod) => pod.metadata.deletionTimestamp === undefined,
  );
  const [pod] = live;
  return live.length === 1 &&
    pod !== undefined &&
    applicationTerminated(pod) === undefined
    ? pod
    : undefined;
}

function finishedBeforeDispatch(
  sandboxName: string,
  sandbox: SandboxObservation,
): ClusterError {
  const detail = positiveConditionDetail(sandbox, "Finished");
  const suffix =
    detail === undefined || detail.length === 0 ? "" : `: ${detail}`;
  return clusterError(
    `agent sandbox "${sandboxName}" finished before dispatch${suffix}`,
  );
}

interface SandboxAddress {
  readonly fqdn: string;
  readonly selector: string;
}

/**
 * The address a Sandbox publishes once it is Ready. A Sandbox reports Ready and
 * its address independently, so both must be present before anything can reach
 * the agent.
 * @param sandbox Current observation of one agent's Sandbox.
 * @returns The service FQDN and Pod selector, or undefined while not reachable.
 */
function readySandboxAddress(
  sandbox: SandboxObservation,
): SandboxAddress | undefined {
  const fqdn = sandbox.status?.serviceFQDN;
  const selector = sandbox.status?.selector;
  return currentConditionIsTrue(sandbox, "Ready") &&
    fqdn !== undefined &&
    selector !== undefined
    ? { fqdn, selector }
    : undefined;
}

/**
 * Observe one agent's readiness for dispatch. Readiness is the Sandbox Ready
 * condition, the application's controller bridge port accepting a connection,
 * and one live application Pod: the bridge is what the controller is about to
 * do, so nothing weaker can claim the agent can serve it.
 *
 * A Sandbox reports Ready as soon as its container starts, well before a
 * runtime listens, and this repeats for the whole startup budget. The bridge
 * probe is a local connect that costs the cluster nothing, while listing Pods
 * is a quorum read of every Pod behind the selector, so the probe gates the
 * list rather than the other way around.
 * @param api Cluster operations for this run.
 * @param sandboxName Sandbox resource that backs one roster entry.
 * @param port Controller bridge port declared by the rendered application.
 * @returns The service address once ready, or undefined to keep polling.
 */
function observeReadySandbox(
  api: KubernetesSocietyApi,
  sandboxName: string,
  port: number,
): Effect.Effect<string | undefined, ClusterError> {
  return Effect.gen(function* () {
    const sandbox = yield* api.readSandbox(sandboxName);
    if (currentConditionIsTrue(sandbox, "Finished")) {
      return yield* Effect.fail(finishedBeforeDispatch(sandboxName, sandbox));
    }
    const address = readySandboxAddress(sandbox);
    if (address === undefined) {
      return undefined;
    }
    if (!(yield* api.bridgeAccepts(address.fqdn, port))) {
      return undefined;
    }
    const pods = yield* api.listPods(address.selector);
    return liveApplicationPod(pods) === undefined ? undefined : address.fqdn;
  });
}

function waitForReadySandbox(
  sandboxName: string,
  port: number,
  session: KubernetesSession,
): Effect.Effect<string, ClusterError> {
  const { api, startupTimeout } = session.options;
  const observe: Effect.Effect<string, ClusterError> = Effect.suspend(() =>
    observeReadySandbox(api, sandboxName, port).pipe(
      Effect.flatMap((fqdn) =>
        fqdn === undefined
          ? Effect.sleep(session.readinessInterval).pipe(
              Effect.zipRight(observe),
            )
          : Effect.succeed(fqdn),
      ),
    ),
  );
  return observe.pipe(
    Effect.timeoutFail({
      duration: startupTimeout,
      onTimeout: () =>
        clusterError(
          `agent sandbox "${sandboxName}" was not ready within ${Duration.format(startupTimeout)}`,
        ),
    }),
  );
}

function terminalEvidence(
  sandboxName: string,
  pod?: PodObservation,
): RuntimeTermination {
  if (pod === undefined) {
    return RuntimeFailed.make({
      detail: `agent sandbox "${sandboxName}" finished without an observable application Pod`,
    });
  }
  const terminated = applicationTerminated(pod);
  if (terminated === undefined) {
    return RuntimeFailed.make({
      detail: `agent sandbox "${sandboxName}" finished without an observable application termination`,
    });
  }
  return terminated.signal !== undefined && terminated.signal > 0
    ? RuntimeSignaled.make({ signal: `signal-${String(terminated.signal)}` })
    : RuntimeExited.make({ code: terminated.exitCode });
}

function finishedEvidence(
  api: KubernetesSocietyApi,
  sandboxName: string,
  sandbox: SandboxObservation,
): Effect.Effect<RuntimeTermination, ClusterError> {
  const selector = sandbox.status?.selector;
  if (selector === undefined) {
    return Effect.succeed(terminalEvidence(sandboxName));
  }
  return api.listPods(selector).pipe(
    Effect.map((pods) =>
      terminalEvidence(
        sandboxName,
        pods.find((pod) => applicationTerminated(pod) !== undefined),
      ),
    ),
  );
}

function terminationSoFar(
  api: KubernetesSocietyApi,
  sandboxName: string,
): Effect.Effect<RuntimeTermination | undefined, ClusterError> {
  return api
    .readSandbox(sandboxName)
    .pipe(
      Effect.flatMap((sandbox) =>
        currentConditionIsTrue(sandbox, "Finished")
          ? finishedEvidence(api, sandboxName, sandbox)
          : Effect.succeed(undefined),
      ),
    );
}

function sandboxLost(sandboxName: string, cause: ClusterError): ClusterError {
  return clusterError(
    `agent sandbox "${sandboxName}" stopped being observable: ${cause.detail}`,
  );
}

/**
 * Observe one agent's Sandbox until it reports Finished.
 *
 * A read is retried while the cluster API is briefly unreachable, but only for
 * as long as the run allows an agent to become ready: past that the Sandbox is
 * gone rather than slow. Retrying a deleted object forever would leave the run
 * waiting on an agent that no longer exists with nothing reporting it, so the
 * loss both ends the session and stands as this agent's terminal evidence.
 * @param sandboxName Sandbox resource that backs one roster entry.
 * @param session Run-scoped observation cadence and loss channel.
 * @returns An Effect that completes with this agent's terminal evidence.
 */
function observeTermination(
  sandboxName: string,
  session: KubernetesSession,
): Effect.Effect<RuntimeTermination> {
  const read = terminationSoFar(session.options.api, sandboxName).pipe(
    Effect.retry(
      Schedule.spaced(session.livenessInterval).pipe(
        Schedule.upTo(session.options.startupTimeout),
      ),
    ),
  );
  const observe: Effect.Effect<RuntimeTermination, ClusterError> =
    Effect.suspend(() =>
      read.pipe(
        Effect.flatMap((evidence) =>
          evidence === undefined
            ? Effect.sleep(session.livenessInterval).pipe(
                Effect.zipRight(observe),
              )
            : Effect.succeed(evidence),
        ),
      ),
    );
  return observe.pipe(
    Effect.catchAll((cause) => {
      const lost = sandboxLost(sandboxName, cause);
      return Deferred.fail(session.lost, lost).pipe(
        Effect.as(RuntimeFailed.make({ detail: lost.detail })),
      );
    }),
  );
}

interface ResolvedCredential {
  readonly secretKey: string;
  readonly value: string;
}

/**
 * Match what the application asked for against what the run actually holds. A
 * credential resolves only when both agree; the record is exhaustive over
 * CredentialName so every downstream view is derived rather than re-enumerated.
 * @param application Rendered application declaring the credentials it wants.
 * @param credentials Provider credentials this run was given.
 * @returns One entry per credential name, undefined where nothing resolves.
 */
function resolveCredentials<Gateway, AcquisitionError>(
  application: Application<Gateway, AcquisitionError>,
  credentials: KubernetesClusterOptions["runtimeCredentials"],
): Readonly<Record<CredentialName, ResolvedCredential | undefined>> {
  const requested = new Set(application.credentials ?? []);
  const resolve = (name: CredentialName): ResolvedCredential | undefined => {
    const value = credentials?.[name];
    return requested.has(name) && value !== undefined
      ? { secretKey: `credential-${name}`, value }
      : undefined;
  };
  return Object.freeze({
    ANTHROPIC_API_KEY: resolve("ANTHROPIC_API_KEY"),
    OPENAI_API_KEY: resolve("OPENAI_API_KEY"),
  });
}

function credentialSecretKeys(
  resolved: Readonly<Record<CredentialName, ResolvedCredential | undefined>>,
): Readonly<Record<CredentialName, string | undefined>> {
  return Object.freeze({
    ANTHROPIC_API_KEY: resolved.ANTHROPIC_API_KEY?.secretKey,
    OPENAI_API_KEY: resolved.OPENAI_API_KEY?.secretKey,
  });
}

interface BootstrapEntry {
  readonly source: string;
  readonly path: string;
  readonly mode: number;
  readonly content: string;
}

function bootstrapEntries(
  files: readonly File[],
): Effect.Effect<readonly BootstrapEntry[], ClusterError> {
  return Effect.gen(function* () {
    const targets = new Set<string>();
    const entries: BootstrapEntry[] = [];
    for (const [index, file] of files.entries()) {
      const normalized = posix.normalize(file.path);
      if (
        !normalized.startsWith(BOOTSTRAP_ROOT) ||
        normalized === BOOTSTRAP_ROOT.slice(0, -1)
      ) {
        return yield* Effect.fail(
          clusterError(
            "distributed bootstrap file must stay below /var/run/moltzap/bootstrap",
          ),
        );
      }
      const path = normalized.slice(BOOTSTRAP_ROOT.length);
      if (targets.has(path)) {
        return yield* Effect.fail(
          clusterError(
            `distributed bootstrap contains duplicate path "${path}"`,
          ),
        );
      }
      if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
        return yield* Effect.fail(
          clusterError(
            `distributed bootstrap contains invalid file mode for "${path}"`,
          ),
        );
      }
      targets.add(path);
      entries.push({
        source: `file-${String(index)}`,
        path,
        mode: file.mode,
        content: file.content,
      });
    }
    return entries;
  });
}

function bootstrapData<Gateway, AcquisitionError>(
  application: Application<Gateway, AcquisitionError>,
  credentials: KubernetesClusterOptions["runtimeCredentials"],
): Effect.Effect<Readonly<Record<string, string>>, ClusterError> {
  return bootstrapEntries(application.files).pipe(
    Effect.map((files) => {
      const credentialData = Object.fromEntries(
        Object.values(resolveCredentials(application, credentials)).flatMap(
          (resolved) =>
            resolved === undefined
              ? []
              : [[resolved.secretKey, resolved.value] as const],
        ),
      );
      return Object.freeze({
        "manifest.json": JSON.stringify({
          apiVersion: "moltzap.bootstrap/v1",
          files: files.map(({ source, path, mode }) => ({
            source,
            path,
            mode,
          })),
        }),
        ...Object.fromEntries(
          files.map(({ source, content }) => [source, content]),
        ),
        ...credentialData,
      });
    }),
  );
}

function holdResource(
  create: Effect.Effect<void, ClusterError>,
  remove: Effect.Effect<void, ClusterError>,
): Effect.Effect<void, ClusterError, Scope.Scope> {
  // The returned Effect retains Scope in its requirements, so the run owns
  // every release registered here.
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- the caller provides the run scope required by the return type
  return Effect.acquireRelease(create, () => remove.pipe(Effect.orDie));
}

/**
 * Watch what the run owns: the capacity reservation it holds, and any acquired
 * Sandbox that stopped being observable at all. Only the reservation is polled
 * here — a vanished Sandbox is discovered by the termination observation that
 * already reads it. An agent that merely dies is the run's own business,
 * reported as that agent's evidence rather than as lost cluster ownership.
 * @param session Run-scoped observation cadence and loss channel.
 * @returns An Effect that fails once the run no longer owns what it reserved.
 */
function sessionFailure(
  session: KubernetesSession,
): Effect.Effect<never, ClusterError> {
  const observe: Effect.Effect<never, ClusterError> = Effect.suspend(() =>
    Effect.gen(function* () {
      const workload = yield* session.options.api.readWorkload(WORKLOAD_NAME);
      if (
        workload.metadata.deletionTimestamp !== undefined ||
        currentConditionIsTrue(workload, "Evicted") ||
        !currentConditionIsTrue(workload, "Admitted") ||
        workload.status?.admission === undefined
      ) {
        return yield* Effect.fail(
          clusterError(
            "complete-roster capacity admission was lost during execution",
          ),
        );
      }
      yield* Effect.sleep(session.livenessInterval);
      return yield* observe;
    }),
  );
  return Effect.raceFirst(observe, Deferred.await(session.lost));
}

function agentLabels(resourceName: string): Readonly<Record<string, string>> {
  return {
    "app.kubernetes.io/managed-by": "moltzap-simulator",
    "moltzap.dev/agent": resourceName,
  };
}

function bootstrapSecretName(resourceName: string): string {
  return `${resourceName}-bootstrap`;
}

function holdBootstrapSecret<Gateway, AcquisitionError>(
  application: Application<Gateway, AcquisitionError>,
  resourceName: string,
  options: KubernetesClusterOptions,
): Effect.Effect<void, ClusterError, Scope.Scope> {
  const secretName = bootstrapSecretName(resourceName);
  return bootstrapData(application, options.runtimeCredentials).pipe(
    Effect.flatMap((data) =>
      holdResource(
        options.api.createSecret(
          bootstrapSecretManifest({
            namespace: options.namespace,
            name: secretName,
            labels: agentLabels(resourceName),
            owner: options.owner,
            data,
          }),
        ),
        options.api.deleteSecret(secretName),
      ),
    ),
  );
}

function sandboxApplication<Gateway, AcquisitionError>(
  application: Application<Gateway, AcquisitionError>,
  container: ContainerRuntime<Gateway, AcquisitionError>,
): SandboxApplication {
  return {
    image: container.image,
    resources: container.resources,
    entrypoint: application.entrypoint,
    environment: application.environment,
    credentials: application.credentials,
    port: application.port,
  };
}

function holdSandbox<Gateway, AcquisitionError>(
  application: Application<Gateway, AcquisitionError>,
  container: ContainerRuntime<Gateway, AcquisitionError>,
  resourceName: string,
  options: KubernetesClusterOptions,
): Effect.Effect<void, ClusterError, Scope.Scope> {
  return holdResource(
    options.api.createSandbox(
      sandboxManifest({
        namespace: options.namespace,
        name: resourceName,
        labels: agentLabels(resourceName),
        owner: options.owner,
        bootstrapSecretName: bootstrapSecretName(resourceName),
        supportImage: options.supportImage,
        application: sandboxApplication(application, container),
        credentialSecretKeys: credentialSecretKeys(
          resolveCredentials(application, options.runtimeCredentials),
        ),
        placement: options.rosterPlacement,
      }),
    ),
    options.api.deleteSandbox(resourceName),
  );
}

function installRenderedApplication<Gateway, AcquisitionError>(
  application: Application<Gateway, AcquisitionError>,
  container: ContainerRuntime<Gateway, AcquisitionError>,
  resourceName: string,
  options: KubernetesClusterOptions,
): Effect.Effect<void, ClusterError, Scope.Scope> {
  return Effect.gen(function* () {
    yield* holdBootstrapSecret(application, resourceName, options);
    yield* holdSandbox(application, container, resourceName, options);
  });
}

type KubernetesAgentAcquisition<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
> = Effect.Effect<
  RunningAgent<RuntimeGatewayOf<Definitions[Name]>>,
  AgentRosterAcquisitionError<Definitions> | ClusterError,
  Scope.Scope
>;

function attachReadyApplication<Gateway, AcquisitionError>(
  application: Application<Gateway, AcquisitionError>,
  sandboxName: string,
  session: KubernetesSession,
): Effect.Effect<
  RunningAgent<Gateway>,
  AcquisitionError | ClusterError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const fqdn = yield* waitForReadySandbox(
      sandboxName,
      application.port,
      session,
    );
    const stopped = observeTermination(sandboxName, session);
    // A runtime can watch its own controller bridge die while the container
    // keeps reporting Running, which nothing in the cluster's view of the
    // Sandbox would ever show. Whichever stop arrives first is the evidence.
    const reported = yield* Deferred.make<RuntimeTermination>();
    const gateway = yield* application.attach(
      { host: fqdn, port: application.port },
      stopped,
      (termination) =>
        Deferred.succeed(reported, termination).pipe(Effect.asVoid),
    );
    return Object.freeze({
      gateway,
      termination: Effect.raceFirst(stopped, Deferred.await(reported)),
    });
  });
}

function acquireKubernetesAgent<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
>(
  input: Slot<Definitions, Name>,
  state: KubernetesSessionState<Definitions>,
): KubernetesAgentAcquisition<Definitions, Name> {
  return Effect.gen(function* () {
    const container = containerRuntimeFor(input.runtime);
    if (container === undefined) {
      return yield* Effect.fail(
        clusterError(
          `runtime "${input.runtime.name}" has no Kubernetes container realization`,
        ),
      );
    }
    const resourceName = state.resourceNames[input.name];
    const application = yield* container.render({ agentName: input.agentName });
    yield* installRenderedApplication(
      application,
      container,
      resourceName,
      state.options,
    );
    const running = yield* attachReadyApplication(
      application,
      resourceName,
      state,
    );
    state.acquired.add(input.name);
    return running;
  });
}

function liveForDispatch(
  api: KubernetesSocietyApi,
  sandboxName: string,
): Effect.Effect<void, ClusterError> {
  return api.readSandbox(sandboxName).pipe(
    Effect.flatMap((sandbox) => {
      if (currentConditionIsTrue(sandbox, "Finished")) {
        return Effect.fail(finishedBeforeDispatch(sandboxName, sandbox));
      }
      return currentConditionIsTrue(sandbox, "Ready")
        ? Effect.void
        : Effect.fail(
            clusterError(
              `agent sandbox "${sandboxName}" stopped being ready before dispatch`,
            ),
          );
    }),
  );
}

/**
 * Gate dispatch on the complete acquired roster. Readiness itself was already
 * established during acquisition; this is the only check that an agent has not
 * died in the window between its own acquisition and the cohort's dispatch, so
 * it reads each Sandbox exactly once rather than re-entering the wait.
 *
 * Only roster entries are ever acquired, so a count that matches the roster is
 * the complete roster.
 * @param roster Complete roster the run reserved capacity for.
 * @param state Run-scoped acquisition bookkeeping.
 * @returns An Effect that completes only when every agent can be dispatched.
 */
function cohortReadiness<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  roster: AgentRoster<Id, Definitions>,
  state: KubernetesSessionState<Definitions>,
): Effect.Effect<void, ClusterError> {
  return Effect.gen(function* () {
    if (state.acquired.size !== roster.validatedDefinitions.length) {
      return yield* Effect.fail(
        clusterError(
          "cohort gate does not contain the complete prepared roster",
        ),
      );
    }
    yield* Effect.forEach(
      roster.validatedDefinitions,
      (entry) =>
        liveForDispatch(state.options.api, state.resourceNames[entry.name]),
      { concurrency: 8, discard: true },
    );
  });
}

function makeKubernetesSession<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  roster: AgentRoster<Id, Definitions>,
  state: KubernetesSessionState<Definitions>,
): Society<Definitions> {
  return Object.freeze({
    acquireAgent: <Name extends Extract<keyof Definitions, string>>(
      input: Slot<Definitions, Name>,
    ) => acquireKubernetesAgent(input, state),
    cohortReady: cohortReadiness(roster, state),
    failure: sessionFailure(state),
  });
}

function namesForRoster<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  roster: AgentRoster<Id, Definitions>,
): Readonly<Record<Extract<keyof Definitions, string>, string>> {
  return /* Safe because a roster's validated entries are exactly its definition keys, each present once. */ Object.freeze(
    Object.fromEntries(
      roster.validatedDefinitions.map((entry, index) => [
        entry.name,
        agentResourceName(index, entry.name),
      ]),
    ),
  ) as Readonly<Record<Extract<keyof Definitions, string>, string>>;
}

/**
 * Refuse a roster that reserves nothing before the run holds any cluster
 * resource, which is what lets the reservation itself require a runtime.
 * @param slots Capacity projected from every roster entry, in roster order.
 * @returns The same slots once at least one of them exists.
 */
function reservableSlots(
  slots: readonly RuntimeCapacitySlot[],
): Effect.Effect<ReservedCapacity, ClusterError> {
  const [first, ...rest] = slots;
  return first === undefined
    ? Effect.fail(
        clusterError(
          "aggregate capacity reservation requires at least one runtime",
        ),
      )
    : Effect.succeed([first, ...rest]);
}

/**
 * Project the whole roster's capacity. Every fact here is already held by the
 * runtime value, so this reads rather than asks the cluster anything.
 * @param roster Complete roster the run reserves capacity for.
 * @returns Capacity for every entry, in roster order.
 */
function capacityForRoster<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  roster: AgentRoster<Id, Definitions>,
): Effect.Effect<ReservedCapacity, ClusterError> {
  return Effect.gen(function* () {
    const slots: RuntimeCapacitySlot[] = [];
    for (const entry of roster.validatedDefinitions) {
      const container = containerRuntimeFor(entry.runtime);
      if (container === undefined) {
        return yield* Effect.fail(
          clusterError(
            `runtime "${entry.runtime.name}" has no Kubernetes container realization`,
          ),
        );
      }
      slots.push({
        image: container.image,
        requests: resourceRequests(container.resources),
      });
    }
    return yield* reservableSlots(slots);
  });
}

function reserveCompleteRoster(
  slots: ReservedCapacity,
  options: KubernetesClusterOptions,
): Effect.Effect<void, ClusterError, Scope.Scope> {
  const labels = {
    "app.kubernetes.io/managed-by": "moltzap-simulator",
    "moltzap.dev/run": options.owner.name,
  };
  return holdResource(
    options.api.createWorkload(
      aggregateWorkloadManifest({
        namespace: options.namespace,
        name: WORKLOAD_NAME,
        queueName: options.queueName,
        labels,
        owner: options.owner,
        slots,
        placement: options.rosterPlacement,
      }),
    ),
    options.api.deleteWorkload(WORKLOAD_NAME),
  );
}

function prepareKubernetesSociety<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  roster: AgentRoster<Id, Definitions>,
  options: KubernetesClusterOptions,
): Effect.Effect<Society<Definitions>, ClusterError, Scope.Scope> {
  return Effect.gen(function* () {
    const resourceNames = namesForRoster(roster);
    yield* reserveCompleteRoster(yield* capacityForRoster(roster), options);
    const readinessInterval =
      options.readinessInterval ?? DEFAULT_READINESS_INTERVAL;
    yield* workloadAdmission(
      options.api,
      options.startupTimeout,
      readinessInterval,
    );
    return makeKubernetesSession(roster, {
      options,
      resourceNames,
      readinessInterval,
      livenessInterval: options.livenessInterval ?? DEFAULT_LIVENESS_INTERVAL,
      acquired: new Set(),
      lost: yield* Deferred.make<never, ClusterError>(),
    });
  });
}

/**
 * Build the private cluster service used by the in-cluster controller.
 * @param options Run-scoped Kubernetes API, identities, images, and deadlines.
 * @returns Cluster service consumed by the simulator kernel.
 */
export function makeKubernetesCluster(
  options: KubernetesClusterOptions,
): ClusterService {
  return Object.freeze({
    prepare: <
      Id extends string,
      Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
    >(
      roster: AgentRoster<Id, Definitions>,
    ) => prepareKubernetesSociety(roster, options),
  });
}

/**
 * Install one run-scoped Kubernetes society behind the kernel boundary.
 * @param options Run-scoped Kubernetes API, identities, images, and deadlines.
 * @returns Layer that supplies only the private cluster service.
 */
export function kubernetesClusterLayer(
  options: KubernetesClusterOptions,
): Layer.Layer<Cluster> {
  return Layer.succeed(Cluster, makeKubernetesCluster(options));
}
