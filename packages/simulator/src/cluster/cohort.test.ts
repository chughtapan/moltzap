/* eslint-disable max-lines-per-function, max-nested-callbacks, sonarjs/max-lines-per-function -- lifecycle regressions keep their ordering, readiness, and cleanup evidence together */

import { assert, describe, it as test } from "vitest";
import { agentId, redactedAgentKey } from "@moltzap/protocol/testing";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  type Scope,
} from "effect";
import { makeAgentHandle } from "../network/participant.js";
import type { AgentConnection } from "../network/router.js";
import {
  defineContainerRuntime,
  image,
  type ApplicationEndpoint,
  type CredentialName,
  type File,
} from "../agents/container.js";
import { AgentRoster } from "../agents/roster.js";
import {
  defineRuntime,
  RuntimeExited,
  RuntimeFailed,
  RuntimeSignaled,
  type AgentRuntimeLike,
  type RuntimeTermination,
} from "../agents/agent.js";
import { ClusterError, type ClusterService, type Society } from "./cluster.js";
import type {
  KubernetesManifest,
  KubernetesSocietyApi,
  PodObservation,
  SandboxObservation,
  WorkloadObservation,
} from "./kubernetes/calls.js";
import {
  makeKubernetesCluster,
  type KubernetesClusterOptions,
} from "./cohort.js";

const SUPPORT_IMAGE = image.make(
  "registry.example/simulator@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const APPLICATION_IMAGE = image.make(
  "registry.example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
);
const ROUTER_URL = Schema.decodeSync(serverBaseUrlSchema)(
  "https://router.run.svc.cluster.local:3000",
);
const runtimeConfiguration = Schema.Struct({ kind: Schema.Literal("fake") });

const WORKLOAD_NAME = "society";
const QUEUE_NAME = "simulator";
const NAMESPACE = "run";
const OBSERVED_GENERATION = 1;
const APPLICATION_CONTAINER = "application";
const WORKLOAD_CREATED = "create:workload";
const WORKLOAD_DELETED = "delete:workload";
const SECRET_CREATED = "create:secret:";
const SANDBOX_CREATED = "create:sandbox:";
const SANDBOX_DELETED = "delete:sandbox:";
const SECRET_KIND = "Secret";
const SANDBOX_KIND = "Sandbox";
const SELECTOR_PREFIX = "sandbox=";
const DELETION_TIMESTAMP = "2026-08-04T17:17:44Z";
const FINISHED_REASON = "PodFailed";
const TERMINATED_REASON = "Error";
const OBSERVED_EXIT_CODE = 17;
const OBSERVED_SIGNAL = 9;
const SIGNAL_EVIDENCE = `signal-${String(OBSERVED_SIGNAL)}`;
const GATEWAY_PORT = 18_789;
const BOOTSTRAP_ROOT = "/var/run/moltzap/bootstrap";
const BOOTSTRAP_CONTENT = "TOP-SECRET-CREDENTIAL";
const READABLE_FILE_MODE = 0o600;
const INVALID_FILE_MODE = 0o1000;
const CREDENTIAL_SECRET_KEY = "credential-ANTHROPIC_API_KEY";
const UNREQUESTED_SECRET_KEY = "credential-OPENAI_API_KEY";
const CREDENTIAL_VALUE = "anthropic-key-never-in-a-manifest";
const UNREQUESTED_CREDENTIAL_VALUE = "openai-key-never-requested";
const INJECTED_API_DETAIL = "observe agent sandbox: injected transport loss";

const POLL_INTERVAL = Duration.millis(1);
/** A liveness interval no test run can reach, so only readiness can progress. */
const UNREACHED_INTERVAL = Duration.hours(1);
/** Long enough for a poll loop to reach its next sleep. */
const SETTLED = Duration.millis(5);
const GENEROUS_TIMEOUT = Duration.seconds(1);
/** Long enough for the poll loop to run many times, short enough to expire. */
const MISSED_TIMEOUT = Duration.millis(50);
const READY_AFTER_PROBES = 4;
const INJECTED_READ_FAILURES = 3;
/** A readiness probe the poll budget can never reach. */
const UNREACHABLE_PROBE = Number.MAX_SAFE_INTEGER;
const NO_CLUSTER_FAILURE = "<no cluster error observed>";

const NOT_ADMITTED = "was not admitted within";
const EMPTY_RESERVATION = "requires at least one runtime";
const DELETED_BEFORE_ADMISSION = "was deleted before admission";
const EVICTED_BEFORE_ADMISSION = "was evicted before admission";
const ADMISSION_LOST = "capacity admission was lost during execution";
const NOT_READY = "was not ready within";
const FINISHED_BEFORE_DISPATCH = "finished before dispatch";
const NO_CONTAINER_REALIZATION = "has no Kubernetes container realization";
const INCOMPLETE_COHORT = "does not contain the complete prepared roster";
const SANDBOX_UNOBSERVABLE = "stopped being observable";
const RUNTIME_BRIDGE_LOST = "runtime bridge disconnected";
const ESCAPING_BOOTSTRAP_PATH = "must stay below /var/run/moltzap/bootstrap";
const DUPLICATE_BOOTSTRAP_PATH = "duplicate path";
const INVALID_BOOTSTRAP_MODE = "invalid file mode";

const sandboxManifestShape = Schema.Struct({
  spec: Schema.Struct({
    podTemplate: Schema.Struct({
      spec: Schema.Struct({ containers: Schema.Array(Schema.Unknown) }),
    }),
  }),
});
const secretManifestShape = Schema.Struct({
  data: Schema.Record({ key: Schema.String, value: Schema.String }),
});

interface FakeKubernetesState {
  admitted: boolean;
  evicted: boolean;
  workloadDeleting: boolean;
  finished: boolean;
  /** Probe index from which the controller bridge port starts accepting. */
  acceptingFromProbe: number;
  bridgeProbes: number;
  /** Remaining readSandbox calls that fail before observation resumes. */
  sandboxReadFailures: number;
  terminationSignal?: number;
  /** Replaces the Pod list one Sandbox selector resolves to. */
  podsFor?: (sandboxName: string) => readonly PodObservation[];
  readonly events: string[];
  readonly manifests: KubernetesManifest[];
  readonly workloadObserved: Deferred.Deferred<undefined>;
}

function workloadConditions(state: FakeKubernetesState) {
  return [
    ...(state.admitted
      ? [
          {
            type: "Admitted",
            status: "True",
            observedGeneration: OBSERVED_GENERATION,
          },
        ]
      : []),
    ...(state.evicted
      ? [
          {
            type: "Evicted",
            status: "True",
            observedGeneration: OBSERVED_GENERATION,
          },
        ]
      : []),
  ];
}

function workload(state: FakeKubernetesState): WorkloadObservation {
  return {
    metadata: {
      name: WORKLOAD_NAME,
      generation: OBSERVED_GENERATION,
      deletionTimestamp: state.workloadDeleting
        ? DELETION_TIMESTAMP
        : undefined,
    },
    status: {
      admission: state.admitted ? { clusterQueue: QUEUE_NAME } : undefined,
      conditions: workloadConditions(state),
    },
  };
}

function sandbox(state: FakeKubernetesState, name: string): SandboxObservation {
  return {
    metadata: { name, generation: OBSERVED_GENERATION },
    status: {
      serviceFQDN: `${name}.run.svc.cluster.local`,
      selector: `${SELECTOR_PREFIX}${name}`,
      conditions: state.finished
        ? [
            {
              type: "Finished",
              status: "True",
              observedGeneration: OBSERVED_GENERATION,
              reason: FINISHED_REASON,
            },
          ]
        : [
            {
              type: "Ready",
              status: "True",
              observedGeneration: OBSERVED_GENERATION,
            },
          ],
    },
  };
}

function terminatedApplication(state: FakeKubernetesState) {
  return state.terminationSignal === undefined
    ? { exitCode: OBSERVED_EXIT_CODE, reason: TERMINATED_REASON }
    : {
        exitCode: 0,
        signal: state.terminationSignal,
        reason: TERMINATED_REASON,
      };
}

function applicationPod(
  state: FakeKubernetesState,
  name: string,
): PodObservation {
  return {
    metadata: { name },
    status: {
      phase: state.finished ? "Failed" : "Running",
      containerStatuses: [
        {
          name: APPLICATION_CONTAINER,
          restartCount: 0,
          state: state.finished
            ? { terminated: terminatedApplication(state) }
            : {},
        },
      ],
    },
  };
}

function deletingPod(pod: PodObservation): PodObservation {
  return {
    ...pod,
    metadata: { ...pod.metadata, deletionTimestamp: DELETION_TIMESTAMP },
  };
}

/**
 * Every backing-Pod shape that is not the one live Pod readiness requires.
 * @param state Fake cluster state the Pod observations are drawn from.
 * @param name Sandbox resource the selector resolved to.
 * @param shape Which unready shape to present.
 * @returns The Pods that Sandbox's selector resolves to.
 */
function backingPods(
  state: FakeKubernetesState,
  name: string,
  shape: "none" | "several" | "terminating",
): readonly PodObservation[] {
  const pod = applicationPod(state, `${name}-pod`);
  if (shape === "none") {
    return [];
  }
  return shape === "several"
    ? [pod, applicationPod(state, `${name}-pod-replacement`)]
    : [deletingPod(pod)];
}

function pods(
  state: FakeKubernetesState,
  selector: string,
): readonly PodObservation[] {
  const name = selector.slice(SELECTOR_PREFIX.length);
  return state.podsFor === undefined
    ? [applicationPod(state, `${name}-pod`)]
    : state.podsFor(name);
}

function record(
  state: FakeKubernetesState,
  event: string,
  manifest?: KubernetesManifest,
): Effect.Effect<void> {
  return Effect.sync(() => {
    state.events.push(event);
    if (manifest !== undefined) {
      state.manifests.push(manifest);
    }
  });
}

function manifestName(manifest: KubernetesManifest): string {
  const metadata = manifest.metadata;
  return metadata instanceof Object && "name" in metadata
    ? String(metadata.name)
    : "unknown";
}

function readSandboxOperation(state: FakeKubernetesState, name: string) {
  return Effect.suspend(() => {
    if (state.sandboxReadFailures > 0) {
      state.sandboxReadFailures -= 1;
      return Effect.fail(new ClusterError({ detail: INJECTED_API_DETAIL }));
    }
    return Effect.succeed(sandbox(state, name));
  });
}

function bridgeAcceptsOperation(state: FakeKubernetesState) {
  return Effect.sync(() => {
    state.bridgeProbes += 1;
    return state.bridgeProbes >= state.acceptingFromProbe;
  });
}

function fakeApi(state: FakeKubernetesState): KubernetesSocietyApi {
  return {
    createWorkload: (manifest) => record(state, WORKLOAD_CREATED, manifest),
    readWorkload: () =>
      Deferred.succeed(state.workloadObserved, undefined).pipe(
        Effect.zipRight(Effect.sync(() => workload(state))),
      ),
    deleteWorkload: () => record(state, WORKLOAD_DELETED),
    createSecret: (manifest) =>
      record(state, `${SECRET_CREATED}${manifestName(manifest)}`, manifest),
    deleteSecret: (name) => record(state, `delete:secret:${name}`),
    createSandbox: (manifest) =>
      record(state, `${SANDBOX_CREATED}${manifestName(manifest)}`, manifest),
    readSandbox: (name) => readSandboxOperation(state, name),
    deleteSandbox: (name) => record(state, `${SANDBOX_DELETED}${name}`),
    listPods: (selector) => Effect.sync(() => pods(state, selector)),
    bridgeAccepts: () => bridgeAcceptsOperation(state),
  };
}

function makeState(
  workloadObserved: Deferred.Deferred<undefined>,
): FakeKubernetesState {
  return {
    admitted: false,
    evicted: false,
    workloadDeleting: false,
    finished: false,
    acceptingFromProbe: 1,
    bridgeProbes: 0,
    sandboxReadFailures: 0,
    events: [],
    manifests: [],
    workloadObserved,
  };
}

const FAKE_RESOURCES = {
  cpuMillis: 500,
  memoryBytes: 268_435_456,
  ephemeralStorageBytes: 268_435_456,
};

const DEFAULT_BOOTSTRAP_FILES: readonly File[] = [
  {
    path: `${BOOTSTRAP_ROOT}/config.json`,
    content: BOOTSTRAP_CONTENT,
    mode: READABLE_FILE_MODE,
  },
];

const DUPLICATED_BOOTSTRAP_FILE = {
  path: `${BOOTSTRAP_ROOT}/config.json`,
  content: BOOTSTRAP_CONTENT,
  mode: READABLE_FILE_MODE,
} satisfies File;

/** One bootstrap request the run must refuse before any Secret exists. */
interface RefusedBootstrap {
  readonly reason: string;
  readonly files: readonly File[];
  readonly detail: string;
}

/** One way the complete-roster reservation fails to reach admission. */
interface UnadmittedReservation {
  readonly reason: string;
  readonly detail: string;
  readonly apply?: (state: FakeKubernetesState) => void;
}

const UNADMITTED_RESERVATIONS: readonly UnadmittedReservation[] = [
  {
    reason: "deleted before admission",
    detail: DELETED_BEFORE_ADMISSION,
    apply: (state) => {
      state.workloadDeleting = true;
    },
  },
  {
    reason: "evicted before admission",
    detail: EVICTED_BEFORE_ADMISSION,
    apply: (state) => {
      state.evicted = true;
    },
  },
  { reason: "never admitted", detail: NOT_ADMITTED },
];

const REFUSED_BOOTSTRAPS: readonly RefusedBootstrap[] = [
  {
    reason: "escapes the bootstrap root",
    files: [
      {
        path: `${BOOTSTRAP_ROOT}/../escape.json`,
        content: BOOTSTRAP_CONTENT,
        mode: READABLE_FILE_MODE,
      },
    ],
    detail: ESCAPING_BOOTSTRAP_PATH,
  },
  {
    reason: "materializes one path twice",
    files: [DUPLICATED_BOOTSTRAP_FILE, DUPLICATED_BOOTSTRAP_FILE],
    detail: DUPLICATE_BOOTSTRAP_PATH,
  },
  {
    reason: "asks for a mode outside the permission range",
    files: [
      {
        path: `${BOOTSTRAP_ROOT}/config.json`,
        content: BOOTSTRAP_CONTENT,
        mode: INVALID_FILE_MODE,
      },
    ],
    detail: INVALID_BOOTSTRAP_MODE,
  },
];

interface FakeRuntimeOptions {
  readonly files?: readonly File[];
  readonly credentials?: readonly CredentialName[];
  readonly onAttach?: (endpoint: ApplicationEndpoint) => void;
  /** A stop only the runtime can see, reported the moment it attaches. */
  readonly reportedStop?: RuntimeTermination;
}

function fakeRuntime(options: FakeRuntimeOptions = {}) {
  return defineContainerRuntime({
    name: "fake-container",
    configuration: {
      schema: runtimeConfiguration,
      value: { kind: "fake" as const },
    },
    image: APPLICATION_IMAGE,
    resources: FAKE_RESOURCES,
    render: (input) =>
      Effect.succeed({
        entrypoint: ["node", "/application.mjs"] as const,
        environment: { AGENT_NAME: input.agentName },
        credentials: options.credentials,
        port: GATEWAY_PORT,
        files: options.files ?? DEFAULT_BOOTSTRAP_FILES,
        attach: (
          endpoint: ApplicationEndpoint,
          stopped: Effect.Effect<RuntimeTermination>,
          reportStopped: (
            termination: RuntimeTermination,
          ) => Effect.Effect<void>,
        ) =>
          Effect.gen(function* () {
            options.onAttach?.(endpoint);
            const reported = options.reportedStop;
            if (reported !== undefined) {
              yield* reportStopped(reported);
            }
            // The gateway carries the cluster's own stop observation so a test
            // can read what the platform handed this runtime.
            return { agentName: input.agentName, stopped };
          }),
      }),
  });
}

/**
 * Define a runtime the Kubernetes platform cannot realize as a container.
 * @returns A runtime with no registered container capability.
 */
function plainRuntime() {
  return defineRuntime<
    { readonly agentName: string },
    never,
    typeof runtimeConfiguration
  >({
    name: "fake-plain",
    configuration: {
      schema: runtimeConfiguration,
      value: { kind: "fake" as const },
    },
  });
}

function connection<const Name extends string>(
  name: Name,
  suffix: number,
): AgentConnection<Name> {
  return {
    agent: makeAgentHandle(
      name,
      agentId(`00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`),
    ),
    key: redactedAgentKey(
      `moltzap_agent_${String(suffix).padStart(16, "0")}_${String(suffix).padStart(48, "0")}`,
    ),
    routerUrl: ROUTER_URL,
  };
}

interface PlatformOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly livenessInterval?: Duration.Duration;
  readonly runtimeCredentials?: KubernetesClusterOptions["runtimeCredentials"];
}

function makePlatform(
  state: FakeKubernetesState,
  options: PlatformOptions = {},
): ClusterService {
  return makeKubernetesCluster({
    api: fakeApi(state),
    namespace: NAMESPACE,
    queueName: QUEUE_NAME,
    owner: { name: "run-root", uid: "root-uid" },
    supportImage: SUPPORT_IMAGE,
    runtimeCredentials: options.runtimeCredentials,
    startupTimeout: options.startupTimeout ?? GENEROUS_TIMEOUT,
    readinessInterval: POLL_INTERVAL,
    livenessInterval: options.livenessInterval ?? POLL_INTERVAL,
  });
}

function acquireFirst<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(session: Society<Definitions>, roster: AgentRoster<Id, Definitions>) {
  const [entry] = roster.validatedDefinitions;
  assert.isDefined(entry);
  return session.acquireAgent({
    name: entry.name,
    agentName: entry.agentName,
    runtime: entry.runtime,
    connection: connection(entry.name, 1),
  });
}

function acquireAll<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(session: Society<Definitions>, roster: AgentRoster<Id, Definitions>) {
  return Effect.forEach(
    roster.validatedDefinitions,
    (entry, index) =>
      session.acquireAgent({
        name: entry.name,
        agentName: entry.agentName,
        runtime: entry.runtime,
        connection: connection(entry.name, index + 1),
      }),
    { concurrency: 2, discard: true },
  );
}

/**
 * Prepare a run, bring up the complete roster, and gate it for dispatch.
 * @param platform Platform under test.
 * @param roster Complete roster the run reserves capacity for.
 * @returns The exit of the whole scoped attempt, releases included.
 */
function acquireCohort<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(platform: ClusterService, roster: AgentRoster<Id, Definitions>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const session = yield* platform.prepare(roster);
      yield* acquireAll(session, roster);
      yield* session.cohortReady;
    }),
  ).pipe(Effect.exit);
}

/**
 * Run one scoped platform attempt under a deadline. A poll loop that never
 * settles reports the cluster events it reached instead of hanging the suite.
 * @param state Fake cluster state whose event trail names the progress made.
 * @param attempt Scoped attempt to run.
 * @returns The attempt's own result, or a failure naming what it reached.
 */
function runWithin<A, E>(
  state: FakeKubernetesState,
  attempt: Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E | Error> {
  return Effect.scoped(attempt).pipe(
    Effect.timeoutFail({
      duration: GENEROUS_TIMEOUT,
      onTimeout: () => new Error(`timed out after: ${state.events.join(",")}`),
    }),
  );
}

function detailOf(candidates: Iterable<unknown>): string | undefined {
  for (const candidate of candidates) {
    if (candidate instanceof ClusterError) {
      return candidate.detail;
    }
  }
  return undefined;
}

/**
 * Read the cluster error the cluster raised in its error channel.
 * @param exit Exit of a scoped platform attempt.
 * @returns The failure detail, or a placeholder when none was raised.
 */
function failureDetail(exit: Exit.Exit<unknown, unknown>): string {
  const candidates = Exit.isFailure(exit) ? Cause.failures(exit.cause) : [];
  return detailOf(candidates) ?? NO_CLUSTER_FAILURE;
}

function created(state: FakeKubernetesState, prefix: string): string[] {
  return state.events.filter((event) => event.startsWith(prefix));
}

function encodedSecretValue(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function manifestsOfKind(
  state: FakeKubernetesState,
  kind: string,
): KubernetesManifest[] {
  return state.manifests.filter((manifest) => manifest.kind === kind);
}

test("reserves the complete roster before creating any Sandbox and releases every resource", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const workloadObserved = yield* Deferred.make<undefined>();
      const state = makeState(workloadObserved);
      const runtime = fakeRuntime();
      const roster = AgentRoster.make("acme.kubernetes-order/v1", {
        alice: runtime,
        bob: runtime,
      });
      const platform = makePlatform(state);

      yield* runWithin(
        state,
        Effect.gen(function* () {
          const preparing = yield* Effect.fork(platform.prepare(roster));
          yield* Deferred.await(workloadObserved);
          assert.deepStrictEqual(state.events, [WORKLOAD_CREATED]);
          state.admitted = true;
          const session = yield* Fiber.join(preparing);
          yield* acquireAll(session, roster);
          yield* session.cohortReady;
        }),
      );

      const firstSandbox = state.events.findIndex((event) =>
        event.startsWith(SANDBOX_CREATED),
      );
      const firstSecret = state.events.findIndex((event) =>
        event.startsWith(SECRET_CREATED),
      );
      assert.strictEqual(state.events[0], WORKLOAD_CREATED);
      assert.isAbove(firstSecret, 0);
      assert.isAbove(firstSandbox, firstSecret);
      assert.lengthOf(created(state, SANDBOX_CREATED), 2);
      assert.lengthOf(created(state, SANDBOX_DELETED), 2);
      assert.strictEqual(state.events.at(-1), WORKLOAD_DELETED);

      const sandboxManifests = manifestsOfKind(state, SANDBOX_KIND);
      assert.lengthOf(sandboxManifests, 2);
      for (const manifest of sandboxManifests) {
        assert.notInclude(JSON.stringify(manifest), BOOTSTRAP_CONTENT);
        const decoded =
          Schema.decodeUnknownSync(sandboxManifestShape)(manifest);
        assert.lengthOf(decoded.spec.podTemplate.spec.containers, 1);
      }
    }),
  ));

test("reports a finished Sandbox as runtime evidence without failing platform ownership", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const state = makeState(yield* Deferred.make<undefined>());
      state.admitted = true;
      const roster = AgentRoster.make("acme.kubernetes-termination/v1", {
        alice: fakeRuntime(),
      });
      const platform = makePlatform(state);

      yield* runWithin(
        state,
        Effect.gen(function* () {
          const session = yield* platform.prepare(roster);
          const running = yield* acquireFirst(session, roster);
          yield* session.cohortReady;
          const ownership = yield* Effect.fork(session.failure);
          state.finished = true;
          const termination = yield* running.termination;
          assert.instanceOf(termination, RuntimeExited);
          assert.strictEqual(termination.code, OBSERVED_EXIT_CODE);
          yield* Effect.sleep(Duration.millis(5));
          assert.isTrue(Option.isNone(yield* Fiber.poll(ownership)));
        }),
      );
    }),
  ));

describe("readiness", () => {
  test("fails the run when a runtime never signals readiness", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        state.acceptingFromProbe = UNREACHABLE_PROBE;
        const roster = AgentRoster.make("acme.kubernetes-never-ready/v1", {
          alice: fakeRuntime(),
        });

        const exit = yield* acquireCohort(
          makePlatform(state, { startupTimeout: MISSED_TIMEOUT }),
          roster,
        );

        assert.include(failureDetail(exit), NOT_READY);
        assert.isAbove(state.bridgeProbes, 1);
        assert.lengthOf(created(state, SANDBOX_DELETED), 1);
        assert.strictEqual(state.events.at(-1), WORKLOAD_DELETED);
      }),
    ));

  test("dispatches the runtime exactly once when the bridge opens after several polls", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        state.acceptingFromProbe = READY_AFTER_PROBES;
        let attachments = 0;
        const roster = AgentRoster.make("acme.kubernetes-late-ready/v1", {
          alice: fakeRuntime({
            onAttach: () => {
              attachments += 1;
            },
          }),
        });

        const exit = yield* acquireCohort(makePlatform(state), roster);

        assert.isTrue(Exit.isSuccess(exit), failureDetail(exit));
        assert.strictEqual(attachments, 1);
        assert.isAtLeast(state.bridgeProbes, READY_AFTER_PROBES);
        assert.lengthOf(created(state, SECRET_CREATED), 1);
        assert.lengthOf(created(state, SANDBOX_CREATED), 1);
      }),
    ));

  test("rejects an agent whose Sandbox reports Finished before dispatch", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        state.finished = true;
        let attachments = 0;
        const roster = AgentRoster.make("acme.kubernetes-finished-early/v1", {
          alice: fakeRuntime({
            onAttach: () => {
              attachments += 1;
            },
          }),
        });

        const exit = yield* acquireCohort(
          makePlatform(state, { startupTimeout: MISSED_TIMEOUT }),
          roster,
        );

        assert.include(failureDetail(exit), FINISHED_BEFORE_DISPATCH);
        assert.include(failureDetail(exit), FINISHED_REASON);
        assert.strictEqual(attachments, 0);
      }),
    ));
});

describe("aggregate capacity admission", () => {
  test("creates no Sandbox and releases a reservation that never admitted", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const refused of UNADMITTED_RESERVATIONS) {
          const state = makeState(yield* Deferred.make<undefined>());
          refused.apply?.(state);
          const roster = AgentRoster.make("acme.kubernetes-unadmitted/v1", {
            alice: fakeRuntime(),
          });

          const exit = yield* acquireCohort(
            makePlatform(state, { startupTimeout: MISSED_TIMEOUT }),
            roster,
          );

          assert.include(failureDetail(exit), refused.detail, refused.reason);
          assert.lengthOf(created(state, SANDBOX_CREATED), 0, refused.reason);
          assert.strictEqual(
            state.events.at(-1),
            WORKLOAD_DELETED,
            refused.reason,
          );
        }
      }),
    ));
});

describe("session ownership", () => {
  test("fails the ownership observation when admission is lost during execution", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        const roster = AgentRoster.make("acme.kubernetes-admission-lost/v1", {
          alice: fakeRuntime(),
        });
        const platform = makePlatform(state);

        yield* runWithin(
          state,
          Effect.gen(function* () {
            const session = yield* platform.prepare(roster);
            yield* acquireFirst(session, roster);
            yield* session.cohortReady;
            const ownership = yield* Effect.fork(session.failure);
            state.admitted = false;
            const exit = yield* Fiber.await(ownership);
            assert.include(failureDetail(exit), ADMISSION_LOST);
          }),
        );
      }),
    ));

  test("fails the ownership observation when an acquired Sandbox stops being observable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        const roster = AgentRoster.make("acme.kubernetes-sandbox-gone/v1", {
          alice: fakeRuntime(),
        });
        const platform = makePlatform(state, {
          startupTimeout: MISSED_TIMEOUT,
        });

        yield* runWithin(
          state,
          Effect.gen(function* () {
            const session = yield* platform.prepare(roster);
            const running = yield* acquireFirst(session, roster);
            yield* session.cohortReady;
            const ownership = yield* Effect.fork(session.failure);
            // The reservation stays admitted throughout, so nothing but the
            // vanished Sandbox can end this run.
            state.sandboxReadFailures = Number.MAX_SAFE_INTEGER;

            const termination = yield* running.termination;
            assert.instanceOf(termination, RuntimeFailed);
            assert.include(termination.detail, SANDBOX_UNOBSERVABLE);
            const exit = yield* Fiber.await(ownership);
            assert.include(failureDetail(exit), SANDBOX_UNOBSERVABLE);
            assert.include(failureDetail(exit), INJECTED_API_DETAIL);
            assert.isTrue(state.admitted);
          }),
        );
      }),
    ));
});

describe("roster gates", () => {
  test("refuses a runtime with no container realization", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        const roster = AgentRoster.make("acme.kubernetes-no-container/v1", {
          alice: plainRuntime(),
        });

        const exit = yield* acquireCohort(
          makePlatform(state, { startupTimeout: MISSED_TIMEOUT }),
          roster,
        );

        assert.include(failureDetail(exit), NO_CONTAINER_REALIZATION);
        assert.lengthOf(created(state, WORKLOAD_CREATED), 0);
      }),
    ));

  test("refuses a roster that reserves no capacity at all", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        const roster = AgentRoster.make("acme.kubernetes-empty-roster/v1", {});

        const exit = yield* Effect.scoped(
          makePlatform(state).prepare(roster),
        ).pipe(Effect.exit);

        assert.include(failureDetail(exit), EMPTY_RESERVATION);
        assert.lengthOf(created(state, WORKLOAD_CREATED), 0);
      }),
    ));

  test("refuses the cohort gate when part of the roster was never acquired", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        const runtime = fakeRuntime();
        const roster = AgentRoster.make("acme.kubernetes-partial-cohort/v1", {
          alice: runtime,
          bob: runtime,
        });
        const platform = makePlatform(state);

        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* platform.prepare(roster);
            yield* acquireFirst(session, roster);
            yield* session.cohortReady;
          }),
        ).pipe(Effect.exit);

        assert.include(failureDetail(exit), INCOMPLETE_COHORT);
        assert.lengthOf(created(state, SANDBOX_CREATED), 1);
      }),
    ));
});

describe("bootstrap data", () => {
  test("creates no Secret for a bootstrap the initializer cannot trust", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const refused of REFUSED_BOOTSTRAPS) {
          const state = makeState(yield* Deferred.make<undefined>());
          state.admitted = true;
          const roster = AgentRoster.make("acme.kubernetes-bad-bootstrap/v1", {
            alice: fakeRuntime({ files: refused.files }),
          });

          const exit = yield* acquireCohort(
            makePlatform(state, { startupTimeout: MISSED_TIMEOUT }),
            roster,
          );

          assert.include(failureDetail(exit), refused.detail, refused.reason);
          assert.lengthOf(created(state, SECRET_CREATED), 0, refused.reason);
        }
      }),
    ));
});

describe("credential injection", () => {
  test("writes a requested provider key into the run Secret and never into a Sandbox", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        const roster = AgentRoster.make("acme.kubernetes-credentials/v1", {
          alice: fakeRuntime({ credentials: ["ANTHROPIC_API_KEY"] }),
        });

        const exit = yield* acquireCohort(
          makePlatform(state, {
            runtimeCredentials: { ANTHROPIC_API_KEY: CREDENTIAL_VALUE },
          }),
          roster,
        );

        assert.isTrue(Exit.isSuccess(exit), failureDetail(exit));
        const secrets = manifestsOfKind(state, SECRET_KIND);
        assert.lengthOf(secrets, 1);
        const [secret] = secrets;
        assert.isDefined(secret);
        const decoded = Schema.decodeUnknownSync(secretManifestShape)(secret);
        assert.strictEqual(
          decoded.data[CREDENTIAL_SECRET_KEY],
          encodedSecretValue(CREDENTIAL_VALUE),
        );

        const sandboxes = manifestsOfKind(state, SANDBOX_KIND);
        assert.lengthOf(sandboxes, 1);
        for (const manifest of sandboxes) {
          const rendered = JSON.stringify(manifest);
          assert.include(rendered, CREDENTIAL_SECRET_KEY);
          assert.notInclude(rendered, CREDENTIAL_VALUE);
          assert.notInclude(rendered, encodedSecretValue(CREDENTIAL_VALUE));
        }
      }),
    ));

  test("withholds a provider key the application never requested", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        const roster = AgentRoster.make("acme.kubernetes-unrequested-key/v1", {
          alice: fakeRuntime({ credentials: ["ANTHROPIC_API_KEY"] }),
        });

        const exit = yield* acquireCohort(
          makePlatform(state, {
            runtimeCredentials: {
              ANTHROPIC_API_KEY: CREDENTIAL_VALUE,
              OPENAI_API_KEY: UNREQUESTED_CREDENTIAL_VALUE,
            },
          }),
          roster,
        );

        assert.isTrue(Exit.isSuccess(exit), failureDetail(exit));
        const [secret] = manifestsOfKind(state, SECRET_KIND);
        assert.isDefined(secret);
        const decoded = Schema.decodeUnknownSync(secretManifestShape)(secret);
        assert.notProperty(decoded.data, UNREQUESTED_SECRET_KEY);

        const rendered = JSON.stringify(state.manifests);
        assert.notInclude(rendered, UNREQUESTED_CREDENTIAL_VALUE);
        assert.notInclude(
          rendered,
          encodedSecretValue(UNREQUESTED_CREDENTIAL_VALUE),
        );
      }),
    ));
});

describe("application pod discovery", () => {
  test("dispatches no Sandbox that is not backed by exactly one live Pod", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const shape of ["none", "several", "terminating"] as const) {
          const state = makeState(yield* Deferred.make<undefined>());
          state.admitted = true;
          state.podsFor = (name) => backingPods(state, name, shape);
          const roster = AgentRoster.make(`acme.kubernetes-${shape}-pods/v1`, {
            alice: fakeRuntime(),
          });

          const exit = yield* acquireCohort(
            makePlatform(state, { startupTimeout: MISSED_TIMEOUT }),
            roster,
          );

          assert.include(failureDetail(exit), NOT_READY, shape);
          // The bridge answered throughout: only the Pod observation refused.
          assert.isAbove(state.bridgeProbes, 0, shape);
        }
      }),
    ));
});

describe("termination evidence", () => {
  test("reports a signalled application as RuntimeSignaled", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        state.terminationSignal = OBSERVED_SIGNAL;
        const roster = AgentRoster.make("acme.kubernetes-signalled/v1", {
          alice: fakeRuntime(),
        });
        const platform = makePlatform(state);

        yield* runWithin(
          state,
          Effect.gen(function* () {
            const session = yield* platform.prepare(roster);
            const running = yield* acquireFirst(session, roster);
            yield* session.cohortReady;
            state.finished = true;
            const termination = yield* running.termination;
            assert.instanceOf(termination, RuntimeSignaled);
            assert.strictEqual(termination.signal, SIGNAL_EVIDENCE);
          }),
        );
      }),
    ));

  test("reports a stop only the runtime can see while its Sandbox still runs", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        const roster = AgentRoster.make("acme.kubernetes-bridge-lost/v1", {
          alice: fakeRuntime({
            reportedStop: RuntimeFailed.make({ detail: RUNTIME_BRIDGE_LOST }),
          }),
        });
        const platform = makePlatform(state);

        yield* runWithin(
          state,
          Effect.gen(function* () {
            const session = yield* platform.prepare(roster);
            const running = yield* acquireFirst(session, roster);
            yield* session.cohortReady;
            // state.finished stays false: the Sandbox never stops reporting
            // Ready, so only the runtime's own report can end this agent.

            const termination = yield* running.termination;
            assert.instanceOf(termination, RuntimeFailed);
            assert.strictEqual(termination.detail, RUNTIME_BRIDGE_LOST);
          }),
        );
      }),
    ));

  test("keeps observing termination across transport failures", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        const roster = AgentRoster.make("acme.kubernetes-observe-retry/v1", {
          alice: fakeRuntime(),
        });
        const platform = makePlatform(state);

        yield* runWithin(
          state,
          Effect.gen(function* () {
            const session = yield* platform.prepare(roster);
            const running = yield* acquireFirst(session, roster);
            yield* session.cohortReady;
            state.finished = true;
            state.sandboxReadFailures = INJECTED_READ_FAILURES;
            const termination = yield* running.termination;
            assert.instanceOf(termination, RuntimeExited);
            assert.strictEqual(termination.code, OBSERVED_EXIT_CODE);
            assert.strictEqual(state.sandboxReadFailures, 0);
          }),
        );
      }),
    ));
});

describe("observation cadence", () => {
  test("holds a running agent to the liveness interval, not the readiness one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = makeState(yield* Deferred.make<undefined>());
        state.admitted = true;
        state.acceptingFromProbe = READY_AFTER_PROBES;
        const roster = AgentRoster.make("acme.kubernetes-cadence/v1", {
          alice: fakeRuntime(),
        });
        const platform = makePlatform(state, {
          livenessInterval: UNREACHED_INTERVAL,
        });

        yield* runWithin(
          state,
          Effect.gen(function* () {
            // Reaching a bridge that opens only after several probes proves
            // readiness kept its own interval.
            const session = yield* platform.prepare(roster);
            const running = yield* acquireFirst(session, roster);
            yield* session.cohortReady;
            assert.isAtLeast(state.bridgeProbes, READY_AFTER_PROBES);

            const observing = yield* Effect.fork(running.termination);
            yield* Effect.sleep(SETTLED);
            yield* Effect.sync(() => {
              state.finished = true;
            });
            yield* Effect.sleep(SETTLED);

            assert.isTrue(Option.isNone(yield* Fiber.poll(observing)));
          }),
        );
      }),
    ));
});

/* eslint-enable max-lines-per-function, max-nested-callbacks, sonarjs/max-lines-per-function -- restore project limits after ordered lifecycle regressions */
