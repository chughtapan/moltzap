/** @file Private Kubernetes realization of one complete simulator society. */

import { posix } from "node:path";
import { Duration, Effect, Layer, type Scope } from "effect";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  RuntimeGatewayOf,
} from "../../runtime/roster.js";
import {
  RuntimeExited,
  RuntimeFailed,
  RuntimeSignaled,
  type AgentRuntimeLike,
  type RunningAgent,
  type RuntimeTermination,
} from "../../runtime/runtime.js";
import {
  distributedRuntimeCapability,
  type DistributedApplicationResourceRequest,
  type DistributedContainerImage,
  type DistributedRuntimeApplication,
  type DistributedRuntimeCapability,
} from "../../runtime/distributed.js";
import {
  SocietyPlatform,
  type SocietyAgentAcquisitionInput,
  type SocietyPlatformService,
  type SocietySession,
} from "../platform.js";
import { SimulatorInfrastructureFailure } from "../failure.js";
import {
  currentConditionIsTrue,
  type KubernetesSocietyApi,
  type PodObservation,
  type SandboxObservation,
} from "./api.js";
import {
  aggregateWorkloadManifest,
  bootstrapSecretManifest,
  type KubernetesRunOwner,
  type RuntimeCapacitySlot,
  sandboxManifest,
} from "./manifests.js";
import type { KubernetesPodPlacement } from "./profile.js";

const WORKLOAD_NAME = "society";
const APPLICATION_CONTAINER_NAME = "application";
const BOOTSTRAP_ROOT = "/var/run/moltzap/bootstrap/";
const DEFAULT_POLL_INTERVAL = Duration.millis(250);

interface ReadySandbox {
  readonly fqdn: string;
  readonly pod: PodObservation;
  readonly selector: string;
}

interface AcquiredSandbox {
  readonly name: string;
  readonly outputIncludes: string;
  readonly port: number;
}

interface TerminatedApplication {
  readonly exitCode: number;
  readonly signal?: number;
  readonly reason?: string;
  readonly message?: string;
}

interface ReadyIdentity {
  readonly fqdn: string;
  readonly selector: string;
}

interface KubernetesSessionState {
  readonly options: KubernetesSocietyPlatformOptions;
  readonly acquired: Map<string, AcquiredSandbox>;
  readonly resourceNames: ReadonlyMap<string, string>;
  readonly pollInterval: Duration.Duration;
}

interface SandboxResourceIdentity {
  readonly resourceName: string;
  readonly secretName: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** Inputs already owned by the run controller and hidden from customer code. */
export interface KubernetesSocietyPlatformOptions {
  readonly api: KubernetesSocietyApi;
  readonly namespace: string;
  readonly queueName: string;
  readonly owner: KubernetesRunOwner;
  readonly supportImage: DistributedContainerImage;
  /** Fixed provider credentials used only by model-configured applications. */
  readonly runtimeCredentials?: Readonly<
    Partial<Record<"ANTHROPIC_API_KEY" | "OPENAI_API_KEY", string>>
  >;
  readonly rosterPlacement?: KubernetesPodPlacement;
  readonly startupTimeout: Duration.Duration;
  readonly pollInterval?: Duration.Duration;
}

function infrastructureFailure(detail: string): SimulatorInfrastructureFailure {
  return new SimulatorInfrastructureFailure({ detail });
}

function resourceRequests(
  resources: DistributedApplicationResourceRequest,
): Readonly<Record<string, string>> {
  return {
    cpu: `${String(resources.cpuMillis)}m`,
    memory: String(resources.memoryBytes),
    "ephemeral-storage": String(resources.ephemeralStorageBytes),
  };
}

function sameResources(
  left: DistributedApplicationResourceRequest,
  right: DistributedApplicationResourceRequest,
): boolean {
  return (
    left.cpuMillis === right.cpuMillis &&
    left.memoryBytes === right.memoryBytes &&
    left.ephemeralStorageBytes === right.ephemeralStorageBytes
  );
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
  pollInterval: Duration.Duration,
): Effect.Effect<void, SimulatorInfrastructureFailure> {
  const observe: Effect.Effect<void, SimulatorInfrastructureFailure> =
    Effect.suspend(() =>
      api.readWorkload(WORKLOAD_NAME).pipe(
        Effect.flatMap((workload) => {
          if (workload.metadata.deletionTimestamp !== undefined) {
            return Effect.fail(
              infrastructureFailure(
                "aggregate capacity reservation was deleted before admission",
              ),
            );
          }
          if (currentConditionIsTrue(workload, "Evicted")) {
            return Effect.fail(
              infrastructureFailure(
                "aggregate capacity reservation was evicted before admission",
              ),
            );
          }
          return currentConditionIsTrue(workload, "Admitted") &&
            workload.status?.admission !== undefined
            ? Effect.void
            : Effect.sleep(pollInterval).pipe(Effect.zipRight(observe));
        }),
      ),
    );
  return observe.pipe(
    Effect.timeoutFail({
      duration: within,
      onTimeout: () =>
        infrastructureFailure(
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

function readyIdentity(sandbox: SandboxObservation): ReadyIdentity | undefined {
  const fqdn = sandbox.status?.serviceFQDN;
  const selector = sandbox.status?.selector;
  return currentConditionIsTrue(sandbox, "Ready") &&
    fqdn !== undefined &&
    selector !== undefined
    ? { fqdn, selector }
    : undefined;
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
): SimulatorInfrastructureFailure {
  const detail = positiveConditionDetail(sandbox, "Finished");
  const suffix =
    detail === undefined || detail.length === 0 ? "" : `: ${detail}`;
  return infrastructureFailure(
    `agent sandbox "${sandboxName}" finished before dispatch${suffix}`,
  );
}

function observeReadySandbox(
  api: KubernetesSocietyApi,
  sandboxName: string,
  outputIncludes: string,
): Effect.Effect<ReadySandbox | undefined, SimulatorInfrastructureFailure> {
  return Effect.gen(function* () {
    const sandbox = yield* api.readSandbox(sandboxName);
    if (currentConditionIsTrue(sandbox, "Finished")) {
      return yield* Effect.fail(finishedBeforeDispatch(sandboxName, sandbox));
    }
    const identity = readyIdentity(sandbox);
    if (identity === undefined) {
      return undefined;
    }
    const pod = liveApplicationPod(yield* api.listPods(identity.selector));
    if (pod === undefined) {
      return undefined;
    }
    const output = yield* api.readPodLog(
      pod.metadata.name,
      APPLICATION_CONTAINER_NAME,
    );
    return output.includes(outputIncludes)
      ? { fqdn: identity.fqdn, pod, selector: identity.selector }
      : undefined;
  });
}

function waitForReadySandbox(
  api: KubernetesSocietyApi,
  acquired: AcquiredSandbox,
  within: Duration.Duration,
  pollInterval: Duration.Duration,
): Effect.Effect<ReadySandbox, SimulatorInfrastructureFailure> {
  const observe: Effect.Effect<ReadySandbox, SimulatorInfrastructureFailure> =
    Effect.suspend(() =>
      observeReadySandbox(api, acquired.name, acquired.outputIncludes).pipe(
        Effect.flatMap((ready) =>
          ready === undefined
            ? Effect.sleep(pollInterval).pipe(Effect.zipRight(observe))
            : Effect.succeed(ready),
        ),
      ),
    );
  return observe.pipe(
    Effect.timeoutFail({
      duration: within,
      onTimeout: () =>
        infrastructureFailure(
          `agent sandbox "${acquired.name}" was not ready within ${Duration.format(within)}`,
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
): Effect.Effect<RuntimeTermination, SimulatorInfrastructureFailure> {
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

function observeTermination(
  api: KubernetesSocietyApi,
  sandboxName: string,
  pollInterval: Duration.Duration,
): Effect.Effect<RuntimeTermination> {
  const observe: Effect.Effect<RuntimeTermination> = Effect.suspend(() =>
    api.readSandbox(sandboxName).pipe(
      Effect.flatMap((sandbox) => {
        if (!currentConditionIsTrue(sandbox, "Finished")) {
          return Effect.sleep(pollInterval).pipe(Effect.zipRight(observe));
        }
        return finishedEvidence(api, sandboxName, sandbox);
      }),
      Effect.catchAll(() =>
        Effect.sleep(pollInterval).pipe(Effect.zipRight(observe)),
      ),
    ),
  );
  return observe;
}

function credentialSecretKey(
  name: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY",
): string {
  return `credential-${name}`;
}

function credentialSecretKeys<Gateway, AcquisitionError>(
  application: DistributedRuntimeApplication<Gateway, AcquisitionError>,
  credentials: KubernetesSocietyPlatformOptions["runtimeCredentials"],
): Readonly<
  Record<"ANTHROPIC_API_KEY" | "OPENAI_API_KEY", string | undefined>
> {
  const requested = new Set(
    application.applicationContainer.credentialEnvironment ?? [],
  );
  return Object.freeze({
    ANTHROPIC_API_KEY:
      requested.has("ANTHROPIC_API_KEY") &&
      credentials?.ANTHROPIC_API_KEY !== undefined
        ? credentialSecretKey("ANTHROPIC_API_KEY")
        : undefined,
    OPENAI_API_KEY:
      requested.has("OPENAI_API_KEY") &&
      credentials?.OPENAI_API_KEY !== undefined
        ? credentialSecretKey("OPENAI_API_KEY")
        : undefined,
  });
}

function bootstrapData<Gateway, AcquisitionError>(
  application: DistributedRuntimeApplication<Gateway, AcquisitionError>,
  credentials: KubernetesSocietyPlatformOptions["runtimeCredentials"],
): Readonly<Record<string, string>> {
  const targets = new Set<string>();
  const files = application.bootstrapSecret.files.map((file, index) => {
    const normalized = posix.normalize(file.path);
    if (
      !normalized.startsWith(BOOTSTRAP_ROOT) ||
      normalized === BOOTSTRAP_ROOT.slice(0, -1)
    ) {
      throw infrastructureFailure(
        "distributed bootstrap file must stay below /var/run/moltzap/bootstrap",
      );
    }
    const path = normalized.slice(BOOTSTRAP_ROOT.length);
    if (targets.has(path)) {
      throw infrastructureFailure(
        `distributed bootstrap contains duplicate path "${path}"`,
      );
    }
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      throw infrastructureFailure(
        `distributed bootstrap contains invalid file mode for "${path}"`,
      );
    }
    targets.add(path);
    return {
      source: `file-${String(index)}`,
      path,
      mode: file.mode,
      content: file.content,
    };
  });
  const credentialData = Object.fromEntries(
    Object.entries(credentialSecretKeys(application, credentials)).flatMap(
      ([name, key]) => {
        const value =
          credentials?.[name as "ANTHROPIC_API_KEY" | "OPENAI_API_KEY"];
        return key === undefined || value === undefined ? [] : [[key, value]];
      },
    ),
  );
  return Object.freeze({
    "manifest.json": JSON.stringify({
      apiVersion: "moltzap.bootstrap/v1",
      files: files.map(({ source, path, mode }) => ({ source, path, mode })),
    }),
    ...Object.fromEntries(
      files.map(({ source, content }) => [source, content]),
    ),
    ...credentialData,
  });
}

function bridgePort<Gateway, AcquisitionError>(
  application: DistributedRuntimeApplication<Gateway, AcquisitionError>,
): number {
  const [port] = application.applicationContainer.ports;
  if (port === undefined) {
    throw infrastructureFailure(
      "distributed application did not declare a controller bridge port",
    );
  }
  return port;
}

function validateRenderedApplication<Gateway, AcquisitionError>(
  application: DistributedRuntimeApplication<Gateway, AcquisitionError>,
  capability: DistributedRuntimeCapability<Gateway, AcquisitionError>,
  bootstrapSecretName: string,
  supportImage: DistributedContainerImage,
): void {
  if (
    application.applicationContainer.image !== capability.reservation.image ||
    !sameResources(
      application.applicationContainer.resources,
      capability.reservation.resources,
    )
  ) {
    throw infrastructureFailure(
      "rendered application does not match its admitted capacity reservation",
    );
  }
  if (
    application.bootstrapSecret.identity !== bootstrapSecretName ||
    application.bootstrapSecret.supportImage !== supportImage
  ) {
    throw infrastructureFailure(
      "rendered application changed its platform-owned bootstrap identity",
    );
  }
  bridgePort(application);
}

function holdResource(
  create: Effect.Effect<void, SimulatorInfrastructureFailure>,
  remove: Effect.Effect<void, SimulatorInfrastructureFailure>,
): Effect.Effect<void, SimulatorInfrastructureFailure, Scope.Scope> {
  // The returned Effect retains Scope in its requirements, so the run owns
  // every release registered here.
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- the caller provides the run scope required by the return type
  return Effect.acquireRelease(create, () => remove.pipe(Effect.orDie));
}

function sessionFailure(
  api: KubernetesSocietyApi,
  acquired: ReadonlyMap<string, AcquiredSandbox>,
  pollInterval: Duration.Duration,
): Effect.Effect<never, SimulatorInfrastructureFailure> {
  const observe: Effect.Effect<never, SimulatorInfrastructureFailure> =
    Effect.suspend(() =>
      Effect.gen(function* () {
        const workload = yield* api.readWorkload(WORKLOAD_NAME);
        if (
          workload.metadata.deletionTimestamp !== undefined ||
          currentConditionIsTrue(workload, "Evicted") ||
          !currentConditionIsTrue(workload, "Admitted") ||
          workload.status?.admission === undefined
        ) {
          return yield* Effect.fail(
            infrastructureFailure(
              "complete-roster capacity admission was lost during execution",
            ),
          );
        }
        yield* Effect.forEach(
          [...acquired.values()],
          (entry) => api.readSandbox(entry.name),
          { concurrency: 8, discard: true },
        );
        yield* Effect.sleep(pollInterval);
        return yield* observe;
      }),
    );
  return observe;
}

function agentLabels(resourceName: string): Readonly<Record<string, string>> {
  return {
    "app.kubernetes.io/managed-by": "moltzap-simulator",
    "moltzap.dev/agent": resourceName,
  };
}

function holdBootstrapSecret<Gateway, AcquisitionError>(
  application: DistributedRuntimeApplication<Gateway, AcquisitionError>,
  secretName: string,
  labels: Readonly<Record<string, string>>,
  options: KubernetesSocietyPlatformOptions,
): Effect.Effect<void, SimulatorInfrastructureFailure, Scope.Scope> {
  return holdResource(
    options.api.createSecret(
      bootstrapSecretManifest({
        namespace: options.namespace,
        name: secretName,
        labels,
        owner: options.owner,
        data: bootstrapData(application, options.runtimeCredentials),
      }),
    ),
    options.api.deleteSecret(secretName),
  );
}

function holdSandbox(
  application: DistributedRuntimeApplication<unknown, unknown>,
  identity: SandboxResourceIdentity,
  options: KubernetesSocietyPlatformOptions,
): Effect.Effect<void, SimulatorInfrastructureFailure, Scope.Scope> {
  return holdResource(
    options.api.createSandbox(
      sandboxManifest({
        namespace: options.namespace,
        name: identity.resourceName,
        labels: identity.labels,
        owner: options.owner,
        bootstrapSecretName: identity.secretName,
        supportImage: options.supportImage,
        application: application.applicationContainer,
        credentialSecretKeys: credentialSecretKeys(
          application,
          options.runtimeCredentials,
        ),
        placement: options.rosterPlacement,
      }),
    ),
    options.api.deleteSandbox(identity.resourceName),
  );
}

function installRenderedApplication<Gateway, AcquisitionError>(
  application: DistributedRuntimeApplication<Gateway, AcquisitionError>,
  capability: DistributedRuntimeCapability<Gateway, AcquisitionError>,
  resourceName: string,
  state: KubernetesSessionState,
): Effect.Effect<AcquiredSandbox, SimulatorInfrastructureFailure, Scope.Scope> {
  const { options } = state;
  const bootstrapSecretName = `${resourceName}-bootstrap`;
  validateRenderedApplication(
    application,
    capability,
    bootstrapSecretName,
    options.supportImage,
  );
  const labels = agentLabels(resourceName);
  return Effect.gen(function* () {
    yield* holdBootstrapSecret(
      application,
      bootstrapSecretName,
      labels,
      options,
    );
    yield* holdSandbox(
      application,
      { resourceName, secretName: bootstrapSecretName, labels },
      options,
    );
    return {
      name: resourceName,
      outputIncludes: application.readiness.outputIncludes,
      port: bridgePort(application),
    };
  });
}

type KubernetesAgentAcquisition<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
> = Effect.Effect<
  RunningAgent<RuntimeGatewayOf<Definitions[Name]>>,
  AgentRosterAcquisitionError<Definitions> | SimulatorInfrastructureFailure,
  Scope.Scope
>;

function attachReadyApplication<Gateway, AcquisitionError>(
  application: DistributedRuntimeApplication<Gateway, AcquisitionError>,
  slot: AcquiredSandbox,
  state: KubernetesSessionState,
): Effect.Effect<
  RunningAgent<Gateway>,
  AcquisitionError | SimulatorInfrastructureFailure,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const { options } = state;
    const ready = yield* waitForReadySandbox(
      options.api,
      slot,
      options.startupTimeout,
      state.pollInterval,
    );
    const termination = observeTermination(
      options.api,
      slot.name,
      state.pollInterval,
    );
    return yield* application.attach({
      endpointUrl: `ws://${ready.fqdn}:${String(slot.port)}`,
      stopped: termination,
      termination,
    });
  });
}

function acquireKubernetesAgent<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
>(
  input: SocietyAgentAcquisitionInput<Definitions, Name>,
  state: KubernetesSessionState,
): KubernetesAgentAcquisition<Definitions, Name> {
  return Effect.gen(function* () {
    const { options } = state;
    const capability = distributedRuntimeCapability(input.runtime);
    if (capability === undefined) {
      return yield* Effect.fail(
        infrastructureFailure(
          `runtime "${input.runtime.name}" has no Kubernetes container realization`,
        ),
      );
    }
    const resourceName = state.resourceNames.get(input.name);
    if (resourceName === undefined) {
      return yield* Effect.fail(
        infrastructureFailure(`roster entry "${input.name}" was not prepared`),
      );
    }
    const bootstrapSecretName = `${resourceName}-bootstrap`;
    const application = yield* capability.render(input, {
      supportImage: options.supportImage,
      bootstrapSecretIdentity: bootstrapSecretName,
    });
    const slot = yield* installRenderedApplication(
      application,
      capability,
      resourceName,
      state,
    );
    const running = yield* attachReadyApplication(application, slot, state);
    state.acquired.set(input.name, slot);
    return running;
  });
}

function cohortReadiness<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  roster: AgentRoster<Id, Definitions>,
  state: KubernetesSessionState,
): Effect.Effect<void, SimulatorInfrastructureFailure> {
  return Effect.gen(function* () {
    if (state.acquired.size !== roster.validatedDefinitions.length) {
      return yield* Effect.fail(
        infrastructureFailure(
          "cohort gate does not contain the complete prepared roster",
        ),
      );
    }
    yield* Effect.forEach(
      roster.validatedDefinitions,
      (entry) => {
        const slot = state.acquired.get(entry.name);
        return slot === undefined
          ? Effect.fail(
              infrastructureFailure(
                `cohort gate is missing roster entry "${entry.name}"`,
              ),
            )
          : waitForReadySandbox(
              state.options.api,
              slot,
              state.options.startupTimeout,
              state.pollInterval,
            );
      },
      { concurrency: 8, discard: true },
    );
  });
}

function makeKubernetesSession<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  roster: AgentRoster<Id, Definitions>,
  options: KubernetesSocietyPlatformOptions,
  resourceNames: ReadonlyMap<string, string>,
  pollInterval: Duration.Duration,
): SocietySession<Definitions> {
  const state: KubernetesSessionState = {
    options,
    resourceNames,
    pollInterval,
    acquired: new Map(),
  };
  return Object.freeze({
    acquireAgent: <Name extends Extract<keyof Definitions, string>>(
      input: SocietyAgentAcquisitionInput<Definitions, Name>,
    ) => acquireKubernetesAgent(input, state),
    cohortReady: cohortReadiness(roster, state),
    failure: sessionFailure(options.api, state.acquired, pollInterval),
  });
}

function namesForRoster<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(roster: AgentRoster<Id, Definitions>): ReadonlyMap<string, string> {
  return new Map(
    roster.validatedDefinitions.map((entry, index) => [
      entry.name,
      agentResourceName(index, entry.name),
    ]),
  );
}

function capacityForRoster<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  roster: AgentRoster<Id, Definitions>,
): Effect.Effect<
  readonly RuntimeCapacitySlot[],
  SimulatorInfrastructureFailure
> {
  return Effect.forEach(
    roster.validatedDefinitions,
    (entry) => {
      const capability = distributedRuntimeCapability(entry.runtime);
      return capability === undefined
        ? Effect.fail(
            infrastructureFailure(
              `runtime "${entry.runtime.name}" has no Kubernetes container realization`,
            ),
          )
        : Effect.succeed({
            image: capability.reservation.image,
            requests: resourceRequests(capability.reservation.resources),
          });
    },
    { concurrency: 8 },
  );
}

function reserveCompleteRoster(
  slots: readonly RuntimeCapacitySlot[],
  options: KubernetesSocietyPlatformOptions,
): Effect.Effect<void, SimulatorInfrastructureFailure, Scope.Scope> {
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
  options: KubernetesSocietyPlatformOptions,
): Effect.Effect<
  SocietySession<Definitions>,
  SimulatorInfrastructureFailure,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const resourceNames = namesForRoster(roster);
    yield* reserveCompleteRoster(yield* capacityForRoster(roster), options);
    const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
    yield* workloadAdmission(options.api, options.startupTimeout, pollInterval);
    return makeKubernetesSession(roster, options, resourceNames, pollInterval);
  });
}

/**
 * Build the private platform service used by the in-cluster controller.
 * @param options Run-scoped Kubernetes API, identities, images, and deadlines.
 * @returns Platform service consumed by the simulator kernel.
 */
export function makeKubernetesSocietyPlatform(
  options: KubernetesSocietyPlatformOptions,
): SocietyPlatformService {
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
 * @returns Layer that supplies only the private society-platform service.
 */
export function kubernetesSocietyPlatformLayer(
  options: KubernetesSocietyPlatformOptions,
): Layer.Layer<SocietyPlatform> {
  return Layer.succeed(SocietyPlatform, makeKubernetesSocietyPlatform(options));
}
