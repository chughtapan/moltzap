/** @file Private Kubernetes realization of one complete simulator society. */

import type { AgentId, AgentName } from "@moltzap/identity";
import { HttpClient } from "@effect/platform";
import { Registry } from "@moltzap/identity/registry";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Schedule,
  Scope,
} from "effect";
import { posix } from "node:path";
import type { AgentRuntimeLike } from "../agents/agent.js";
import type { HarvestedFileOutcome } from "../events/core.js";
import type { KubernetesPodPlacement } from "./profile.js";
import { containerRuntimeFor } from "../agents/container.js";
import {
  type AgentRoster,
  type AgentRosterAcquisitionError,
  type Application,
  type ContainerRuntime,
  type CredentialName,
  type File,
  type HarvestTarget,
  type Image,
  type Resources,
  type RunningAgent,
  RuntimeExited,
  RuntimeFailed,
  type RuntimeGatewayOf,
  RuntimeSignaled,
  type RuntimeTermination,
  type StartedAgent,
} from "../agents/index.js";
import {
  makeAgentHandle,
  makeRouterStopReport,
  networkError,
  type NetworkError,
  type Router,
  RouterProvider,
  type RouterProviderService,
  type RouterStopped,
} from "../network/index.js";
import {
  type AdvertisedRouterFaultProxyPlatform,
  Cluster,
  ClusterError,
  type ClusterService,
  type HarvestedWorkspaceFile,
  type Slot,
  type Society,
} from "./cluster.js";
import {
  type ControlledEndpointRuntime,
  makeControlledEndpointRuntime,
} from "./controlled-endpoint.js";
import {
  currentConditionIsTrue,
  type KubernetesSocietyApi,
  type PodObservation,
  type SandboxObservation,
} from "./kubernetes/calls.js";
import {
  endpointStateClaimManifest,
  REGISTRY_STATE_CLAIM_NAME,
  SOCIETY_NETWORK_SECRET_NAME,
  societyNetworkManifests,
} from "./kubernetes/network-objects.js";
import {
  aggregateWorkloadManifest,
  APPLICATION_CONTAINER_NAME,
  bootstrapSecretManifest,
  type KubernetesRunOwner,
  type ReservedCapacity,
  type RuntimeCapacitySlot,
  type SandboxApplication,
  sandboxManifest,
} from "./kubernetes/objects.js";
import {
  ADMISSION_CREDENTIAL_SECRET_KEY,
  AGENT_PRIVATE_KEY_SECRET_KEY,
  type AgentDaemonAuthority,
  generateAgentDaemonAuthority,
  generateSocietyNetworkAuthority,
  REGISTRY_PORT,
  REGISTRY_SERVICE_NAME,
  ROUTER_PORT,
  ROUTER_SERVICE_NAME,
  type SocietyNetworkAuthority,
  societyNetworkConfiguration,
} from "./society-network.js";

// safer-arch-ignore no-cross-domain-sibling-import: Bringing a roster up is inherently cross-domain: it renders agents and reserves cluster capacity.
// safer-arch-ignore no-fat-orchestrator: The private Kubernetes society composition boundary owns the complete roster-to-capacity acquisition and supervision transaction.
/* eslint-disable max-lines -- This private composition hub keeps one Kubernetes society lifecycle auditable in one place. */

const WORKLOAD_NAME = "society";
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

/** What the run remembers about one attached application, to read it later. */
interface AcquiredApplication {
  readonly sandboxName: string;
  /** Pod selector the Sandbox reported when it became ready; stable for the run. */
  readonly selector: string;
  readonly harvest: readonly HarvestTarget[];
}

interface AttachedApplication<Gateway> {
  readonly running: RunningAgent<Gateway>;
  readonly selector: string;
}

interface KubernetesSessionState<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> extends KubernetesSession {
  /** Roster entries whose Sandbox reached readiness and attached. */
  readonly acquired: Map<string, AcquiredApplication>;
  readonly network: ActiveSocietyNetwork;
  readonly resourceNames: Readonly<
    Record<Extract<keyof Definitions, string>, string>
  >;
}

/** Registry lookup injected behind the private Kubernetes composition seam. */
export type SocietyAgentIdResolver = (
  authority: SocietyNetworkAuthority,
  agentName: AgentName,
) => Effect.Effect<AgentId, ClusterError>;

/** One ready network held by the Router fixture's child scope. */
interface ActiveSocietyNetwork {
  readonly authority: SocietyNetworkAuthority;
  readonly controlledEndpoints: ControlledEndpointRuntime;
  readonly resolveAgentId: (
    agentName: AgentName,
  ) => Effect.Effect<AgentId, ClusterError>;
  readonly router: Router;
  readonly stopped: Deferred.Deferred<RouterStopped, NetworkError>;
  readonly scope: Scope.CloseableScope;
}

/** Cluster and Router services sharing one run-scoped network owner. */
export interface KubernetesPlatform {
  readonly cluster: ClusterService;
  readonly routerProvider: RouterProviderService;
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
  /**
   * How long the queue may hold the reservation before admission, apart from
   * `startupTimeout`: a cohort waiting behind other runs has not started, so
   * the wait must not spend the budget its readiness is measured against.
   */
  readonly admissionTimeout: Duration.Duration;
  /** Controller-private listener and mandatory in-cluster Service identity. */
  readonly routerFaultProxy: AdvertisedRouterFaultProxyPlatform;
  /** How often admission and readiness are observed while the run starts. */
  readonly readinessInterval?: Duration.Duration;
  /** How often a running agent and the reservation are observed to still be there. */
  readonly livenessInterval?: Duration.Duration;
}

/**
 * Build the private Kubernetes services around one shared network owner.
 * @param options Run-scoped Kubernetes API, identities, images, and deadlines.
 * @param resolveAgentId Resolves the immutable card issued by the run Registry.
 * @returns Cluster and Router services consumed by the simulator kernel.
 */
export function makeKubernetesPlatform(
  options: KubernetesClusterOptions,
  resolveAgentId: SocietyAgentIdResolver,
): KubernetesPlatform {
  const network = makeNetworkLifecycle(options, resolveAgentId);
  return Object.freeze({
    cluster: makeKubernetesClusterService(options, network.current),
    routerProvider: makeKubernetesRouterProvider(network),
  });
}

/**
 * Install one run-scoped Kubernetes network and society behind the kernel.
 * @param options Run-scoped Kubernetes API, identities, images, and deadlines.
 * @returns Layer that supplies the shared Router fixture and private cluster.
 */
export function kubernetesClusterLayer(
  options: KubernetesClusterOptions,
): Layer.Layer<Cluster | RouterProvider, never, HttpClient.HttpClient> {
  return Layer.effectContext(
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const resolveAgentId: SocietyAgentIdResolver = (authority, agentName) => {
        const registryLayer = Registry.layer({
          origin: new URL(authority.registryOrigin),
          registrySignerPublicKey: authority.registrySignerPublicKey,
          requestTimeout: options.startupTimeout,
        }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
        );
        return Registry.lookup({ agentName }).pipe(
          Effect.provide(registryLayer),
          Effect.mapError(() =>
            clusterError(
              "Registry lookup failed while resolving a ready agent identity",
            ),
          ),
          Effect.flatMap((result) =>
            result.kind === "found"
              ? Effect.succeed(result.agentCard.agentId)
              : Effect.fail(
                  clusterError(
                    "Registry did not contain the agent after registrar readiness",
                  ),
                ),
          ),
        );
      };
      const platform = makeKubernetesPlatform(options, resolveAgentId);
      return Context.make(Cluster, platform.cluster).pipe(
        Context.add(RouterProvider, platform.routerProvider),
      );
    }).pipe(Effect.withSpan("kubernetesClusterLayer")),
  );
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

function livePodName(
  sandboxName: string,
  pods: readonly PodObservation[],
): Effect.Effect<string, ClusterError> {
  const podName = liveApplicationPod(pods)?.metadata.name;
  return podName === undefined
    ? Effect.fail(
        clusterError(
          `agent sandbox "${sandboxName}" has no live application Pod to read`,
        ),
      )
    : Effect.succeed(podName);
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
): Effect.Effect<SandboxAddress | undefined, ClusterError> {
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
    return liveApplicationPod(pods) === undefined ? undefined : address;
  });
}

function waitForReadySandbox(
  sandboxName: string,
  port: number,
  session: KubernetesSession,
): Effect.Effect<SandboxAddress, ClusterError> {
  const { api, startupTimeout } = session.options;
  const observe: Effect.Effect<SandboxAddress, ClusterError> = Effect.suspend(
    () =>
      observeReadySandbox(api, sandboxName, port).pipe(
        Effect.flatMap((address) =>
          address === undefined
            ? Effect.sleep(session.readinessInterval).pipe(
                Effect.zipRight(observe),
              )
            : Effect.succeed(address),
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

function applicationTerminated(
  pod: PodObservation,
): TerminatedApplication | undefined {
  return pod.status?.containerStatuses?.find(
    (entry) => entry.name === APPLICATION_CONTAINER_NAME,
  )?.state.terminated;
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

interface ResolvedCredential {
  readonly secretKey: string;
  readonly value: string;
}

function holdBootstrapSecret(
  data: Readonly<Record<string, string>>,
  resourceName: string,
  options: KubernetesClusterOptions,
): Effect.Effect<void, ClusterError, Scope.Scope> {
  const secretName = bootstrapSecretName(resourceName);
  return holdResource(
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
  );
}

function holdEndpointState(
  resourceName: string,
  options: KubernetesClusterOptions,
): Effect.Effect<void, ClusterError, Scope.Scope> {
  const name = endpointStateClaimName(resourceName);
  return holdResource(
    options.api.createPersistentVolumeClaim(
      endpointStateClaimManifest({
        namespace: options.namespace,
        name,
        labels: agentLabels(resourceName),
        owner: options.owner,
      }),
    ),
    options.api.deletePersistentVolumeClaim(name),
  );
}

// eslint-disable-next-line max-params -- This private composition point binds the rendered application, cluster identity, network authority, and daemon authority atomically.
function holdSandbox<Gateway, AcquisitionError>(
  application: Application<Gateway, AcquisitionError>,
  container: ContainerRuntime<Gateway, AcquisitionError>,
  resourceName: string,
  agentName: string,
  options: KubernetesClusterOptions,
  network: SocietyNetworkAuthority,
  daemon: AgentDaemonAuthority,
): Effect.Effect<void, ClusterError, Scope.Scope> {
  const configuration = societyNetworkConfiguration(network);
  return holdResource(
    options.api.createSandbox(
      sandboxManifest({
        namespace: options.namespace,
        name: resourceName,
        labels: agentLabels(resourceName),
        owner: options.owner,
        bootstrapSecretName: bootstrapSecretName(resourceName),
        supportImage: options.supportImage,
        network: {
          ...configuration,
          routerOrigin:
            options.routerFaultProxy.listener.advertisedOrigin.origin,
        },
        daemon,
        endpointStateClaimName: endpointStateClaimName(resourceName),
        agentName,
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

interface PreparedAgentBootstrap {
  readonly data: Readonly<Record<string, string>>;
  readonly daemon: AgentDaemonAuthority;
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
  network: SocietyNetworkAuthority,
): Effect.Effect<PreparedAgentBootstrap, ClusterError> {
  return Effect.gen(function* () {
    const files = yield* bootstrapEntries(application.files);
    const daemon = yield* Effect.try({
      try: generateAgentDaemonAuthority,
      catch: () => clusterError("could not generate endpoint authority"),
    });
    const credentialData = Object.fromEntries(
      Object.values(resolveCredentials(application, credentials)).flatMap(
        (resolved) =>
          resolved === undefined
            ? []
            : [[resolved.secretKey, resolved.value] as const],
      ),
    );
    return Object.freeze({
      daemon,
      data: Object.freeze({
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
        [AGENT_PRIVATE_KEY_SECRET_KEY]: daemon.privateKeyPem,
        [ADMISSION_CREDENTIAL_SECRET_KEY]: network.admissionCredential,
      }),
    });
  });
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

function makeKubernetesSession<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  roster: AgentRoster<Id, Definitions>,
  state: KubernetesSessionState<Definitions>,
): Society<Definitions> {
  return Object.freeze({
    routerFaultProxy: state.options.routerFaultProxy,
    acquireAgent: <Name extends Extract<keyof Definitions, string>>(
      input: Slot<Definitions, Name>,
    ) => acquireKubernetesAgent(input, state),
    acquireEndpoint: state.network.controlledEndpoints.acquire,
    harvestWorkspace: (name: Extract<keyof Definitions, string>) =>
      harvestWorkspace(name, state),
    cohortReady: cohortReadiness(roster, state),
    failure: sessionFailure(state),
  });
}

/**
 * Read every target one attached application declared, from its live Pod.
 *
 * The live Pod is found once per agent, through the selector recorded when
 * its Sandbox became ready, and the targets are read one at a time through
 * it, so an agent contributes one exec session per file rather than a burst.
 * A Pod that cannot be found makes every target unreadable with the same
 * cause; a single read that fails makes only that target unreadable. The
 * agent is named by its roster key, and the outcomes come back one per
 * declared target, in declaration order.
 */
function harvestWorkspace(
  name: string,
  state: KubernetesSession & {
    readonly acquired: ReadonlyMap<string, AcquiredApplication>;
  },
): Effect.Effect<readonly HarvestedWorkspaceFile[]> {
  const acquired = state.acquired.get(name);
  if (acquired === undefined || acquired.harvest.length === 0) {
    return Effect.succeed([]);
  }
  const { api } = state.options;
  const { harvest } = acquired;
  return api.listPods(acquired.selector).pipe(
    Effect.flatMap((pods) => livePodName(acquired.sandboxName, pods)),
    Effect.flatMap((podName) =>
      Effect.forEach(harvest, (target) => harvestTarget(api, podName, target), {
        concurrency: 1,
      }),
    ),
    Effect.catchAll((cause) =>
      Effect.succeed(
        harvest.map((target) => ({
          relativePath: target.relativePath,
          outcome: unreadable(cause.detail),
        })),
      ),
    ),
    Effect.withSpan("harvestWorkspace", { attributes: { "agent.name": name } }),
  );
}

function harvestTarget(
  api: KubernetesSocietyApi,
  podName: string,
  target: HarvestTarget,
): Effect.Effect<HarvestedWorkspaceFile> {
  return api.readApplicationFile(podName, target.path, target.limitBytes).pipe(
    Effect.catchAll((cause) => Effect.succeed(unreadable(cause.detail))),
    Effect.map((outcome) => ({ relativePath: target.relativePath, outcome })),
  );
}

function unreadable(cause: string): HarvestedFileOutcome {
  return { _tag: "unreadable", cause };
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

function endpointStateClaimName(resourceName: string): string {
  return `${resourceName}-endpoint-state`;
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

// eslint-disable-next-line max-params -- This private composition point installs the bootstrap, durable endpoint state, and Sandbox under one scope.
function installRenderedApplication<Gateway, AcquisitionError>(
  application: Application<Gateway, AcquisitionError>,
  container: ContainerRuntime<Gateway, AcquisitionError>,
  resourceName: string,
  agentName: string,
  options: KubernetesClusterOptions,
  network: SocietyNetworkAuthority,
): Effect.Effect<void, ClusterError, Scope.Scope> {
  return Effect.gen(function* () {
    const bootstrap = yield* bootstrapData(
      application,
      options.runtimeCredentials,
      network,
    );
    yield* holdBootstrapSecret(bootstrap.data, resourceName, options);
    yield* holdEndpointState(resourceName, options);
    yield* holdSandbox(
      application,
      container,
      resourceName,
      agentName,
      options,
      network,
      bootstrap.daemon,
    );
  });
}

type KubernetesAgentAcquisition<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
> = Effect.Effect<
  StartedAgent<Name, RuntimeGatewayOf<Definitions[Name]>>,
  AgentRosterAcquisitionError<Definitions> | ClusterError,
  Scope.Scope
>;

function attachReadyApplication<Gateway, AcquisitionError>(
  application: Application<Gateway, AcquisitionError>,
  sandboxName: string,
  session: KubernetesSession,
): Effect.Effect<
  AttachedApplication<Gateway>,
  AcquisitionError | ClusterError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const address = yield* waitForReadySandbox(
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
      { host: address.fqdn, port: application.port },
      stopped,
      (termination) =>
        Deferred.succeed(reported, termination).pipe(Effect.asVoid),
    );
    return {
      running: Object.freeze({
        gateway,
        termination: Effect.raceFirst(stopped, Deferred.await(reported)),
      }),
      selector: address.selector,
    };
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
      input.agentName,
      state.options,
      state.network.authority,
    );
    const attached = yield* attachReadyApplication(
      application,
      resourceName,
      state,
    );
    const agentId = yield* state.network.resolveAgentId(input.agentName);
    state.acquired.set(input.name, {
      sandboxName: resourceName,
      selector: attached.selector,
      harvest: application.harvest ?? [],
    });
    return Object.freeze({
      ...attached.running,
      agent: makeAgentHandle(input.name, agentId),
    });
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

function waitForSocietyNetwork(
  options: KubernetesClusterOptions,
): Effect.Effect<void, ClusterError> {
  const registryHost = `${REGISTRY_SERVICE_NAME}.${options.namespace}.svc.cluster.local`;
  const routerHost = `${ROUTER_SERVICE_NAME}.${options.namespace}.svc.cluster.local`;
  const observe: Effect.Effect<void, ClusterError> = Effect.suspend(() =>
    Effect.all(
      [
        options.api.serviceAccepts(registryHost, REGISTRY_PORT),
        options.api.serviceAccepts(routerHost, ROUTER_PORT),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.flatMap(([registryReady, routerReady]) =>
        registryReady && routerReady
          ? Effect.void
          : Effect.sleep(DEFAULT_READINESS_INTERVAL).pipe(
              Effect.zipRight(observe),
            ),
      ),
    ),
  );
  return observe.pipe(
    Effect.timeoutFail({
      duration: options.startupTimeout,
      onTimeout: () =>
        clusterError(
          `run Registry and Router were not ready within ${Duration.format(options.startupTimeout)}`,
        ),
    }),
  );
}

function holdSocietyNetwork(
  options: KubernetesClusterOptions,
): Effect.Effect<SocietyNetworkAuthority, ClusterError, Scope.Scope> {
  return Effect.gen(function* () {
    const authority = yield* Effect.try({
      try: () => generateSocietyNetworkAuthority(options.namespace),
      catch: () => clusterError("could not generate run network authority"),
    });
    const manifests = societyNetworkManifests({
      namespace: options.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "moltzap-simulator",
        "moltzap.dev/run": options.owner.name,
      },
      owner: options.owner,
      supportImage: options.supportImage,
      authority,
    });
    yield* holdResource(
      options.api.createSecret(manifests.secret),
      options.api.deleteSecret(SOCIETY_NETWORK_SECRET_NAME),
    );
    yield* holdResource(
      options.api.createPersistentVolumeClaim(manifests.registryState),
      options.api.deletePersistentVolumeClaim(REGISTRY_STATE_CLAIM_NAME),
    );
    yield* holdResource(
      options.api.createService(manifests.registryService),
      options.api.deleteService(REGISTRY_SERVICE_NAME),
    );
    yield* holdResource(
      options.api.createService(manifests.routerService),
      options.api.deleteService(ROUTER_SERVICE_NAME),
    );
    yield* holdResource(
      options.api.createDeployment(manifests.registryDeployment),
      options.api.deleteDeployment(REGISTRY_SERVICE_NAME),
    );
    yield* holdResource(
      options.api.createDeployment(manifests.routerDeployment),
      options.api.deleteDeployment(ROUTER_SERVICE_NAME),
    );
    yield* waitForSocietyNetwork(options);
    return authority;
  });
}

function prepareKubernetesSociety<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  roster: AgentRoster<Id, Definitions>,
  options: KubernetesClusterOptions,
  network: ActiveSocietyNetwork,
): Effect.Effect<Society<Definitions>, ClusterError, Scope.Scope> {
  return Effect.gen(function* () {
    const resourceNames = namesForRoster(roster);
    yield* reserveCompleteRoster(yield* capacityForRoster(roster), options);
    const readinessInterval =
      options.readinessInterval ?? DEFAULT_READINESS_INTERVAL;
    yield* workloadAdmission(
      options.api,
      options.admissionTimeout,
      readinessInterval,
    );
    return makeKubernetesSession(roster, {
      options,
      network,
      resourceNames,
      readinessInterval,
      livenessInterval: options.livenessInterval ?? DEFAULT_LIVENESS_INTERVAL,
      acquired: new Map(),
      lost: yield* Deferred.make<never, ClusterError>(),
    });
  });
}

function inactiveNetwork(): ClusterError {
  return clusterError(
    "run Router must be acquired before preparing the society cluster",
  );
}

function closeActiveNetwork(
  network: ActiveSocietyNetwork,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const closed = yield* Scope.close(network.scope, Exit.void).pipe(
      Effect.exit,
    );
    if (Exit.isFailure(closed)) {
      yield* Deferred.fail(
        network.stopped,
        networkError(
          "stop-router",
          "run network resources could not be released",
        ),
      );
      return;
    }
    yield* Deferred.succeed(network.stopped, makeRouterStopReport());
  }).pipe(Effect.asVoid);
}

interface NetworkLifecycle {
  readonly acquire: Effect.Effect<ActiveSocietyNetwork, NetworkError>;
  readonly current: Effect.Effect<ActiveSocietyNetwork, ClusterError>;
  readonly release: (network: ActiveSocietyNetwork) => Effect.Effect<void>;
}

interface NetworkLifecycleState {
  active?: ActiveSocietyNetwork;
  readonly transition: Effect.Semaphore;
}

function makeNetworkLifecycle(
  options: KubernetesClusterOptions,
  resolveAgentId: SocietyAgentIdResolver,
): NetworkLifecycle {
  const state: NetworkLifecycleState = {
    transition: Effect.unsafeMakeSemaphore(1),
  };
  return Object.freeze({
    acquire: acquireSocietyNetwork(state, options, resolveAgentId),
    current: currentSocietyNetwork(state),
    release: (network: ActiveSocietyNetwork) =>
      releaseSocietyNetwork(state, network),
  });
}

function makeKubernetesClusterService(
  options: KubernetesClusterOptions,
  currentNetwork: Effect.Effect<ActiveSocietyNetwork, ClusterError>,
): ClusterService {
  return Object.freeze({
    prepare: <
      Id extends string,
      Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
    >(
      roster: AgentRoster<Id, Definitions>,
    ) =>
      currentNetwork.pipe(
        Effect.flatMap((network) =>
          prepareKubernetesSociety(roster, options, network),
        ),
      ),
  });
}

function makeKubernetesRouterProvider(
  network: NetworkLifecycle,
): RouterProviderService {
  return Object.freeze({
    // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- RouterProvider.acquire retains Scope in its public contract, so the run owns release.
    acquire: Effect.acquireRelease(network.acquire, network.release).pipe(
      Effect.map((active) => active.router),
    ),
  });
}

function acquireSocietyNetwork(
  state: NetworkLifecycleState,
  options: KubernetesClusterOptions,
  resolveAgentId: SocietyAgentIdResolver,
): Effect.Effect<ActiveSocietyNetwork, NetworkError> {
  return state.transition.withPermits(1)(
    Effect.gen(function* () {
      if (state.active !== undefined) {
        return yield* Effect.fail(
          networkError(
            "acquire-router",
            "run Router has already been acquired",
          ),
        );
      }
      const scope = yield* Scope.make();
      const authority = yield* holdSocietyNetwork(options).pipe(
        Scope.extend(scope),
        Effect.mapError((cause) => networkError("acquire-router", cause)),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      const stopped = yield* Deferred.make<RouterStopped, NetworkError>();
      const controlledEndpoints = makeControlledEndpointRuntime({
        authority,
        resolveAgentId: (agentName) =>
          resolveAgentId(authority, agentName).pipe(
            Effect.mapError((cause) => networkError("attach-endpoint", cause)),
          ),
      });
      const network: ActiveSocietyNetwork = Object.freeze({
        authority,
        controlledEndpoints,
        resolveAgentId: (agentName: AgentName) =>
          resolveAgentId(authority, agentName),
        router: Object.freeze({
          address: new URL(authority.routerOrigin),
          stopped: Deferred.await(stopped),
        }),
        stopped,
        scope,
      });
      // eslint-disable-next-line require-atomic-updates -- The transition semaphore serializes the checked state mutation across Effect suspension.
      state.active = network;
      return network;
    }).pipe(Effect.withSpan("makeKubernetesPlatform.acquireNetwork")),
  );
}

function releaseSocietyNetwork(
  state: NetworkLifecycleState,
  network: ActiveSocietyNetwork,
): Effect.Effect<void> {
  return state.transition.withPermits(1)(
    Effect.gen(function* () {
      if (state.active === network) {
        delete state.active;
      }
      yield* closeActiveNetwork(network);
    }).pipe(Effect.withSpan("makeKubernetesPlatform.releaseNetwork")),
  );
}

function currentSocietyNetwork(
  state: NetworkLifecycleState,
): Effect.Effect<ActiveSocietyNetwork, ClusterError> {
  return state.transition.withPermits(1)(
    Effect.suspend(() =>
      state.active === undefined
        ? Effect.fail(inactiveNetwork())
        : Effect.succeed(state.active),
    ),
  );
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

function clusterError(detail: string): ClusterError {
  return new ClusterError({ detail });
}

/* eslint-enable max-lines -- Restore the workspace file-size limit outside this composition hub. */
