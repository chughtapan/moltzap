/* eslint-disable max-lines-per-function, max-nested-callbacks, sonarjs/max-lines-per-function -- lifecycle regressions keep their ordering and cleanup evidence together */

import { assert, it as test } from "vitest";
import { agentId, redactedAgentKey } from "@moltzap/protocol/testing";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import { Deferred, Duration, Effect, Fiber, Option, Schema } from "effect";
import { makeAgentHandle } from "../../network/participant.js";
import type { AgentConnection } from "../../network/router.js";
import {
  defineDistributedRuntime,
  type DistributedContainerImage,
} from "../../runtime/distributed.js";
import { AgentRoster } from "../../runtime/roster.js";
import { RuntimeExited } from "../../runtime/runtime.js";
import type {
  KubernetesManifest,
  KubernetesSocietyApi,
  PodObservation,
  SandboxObservation,
  WorkloadObservation,
} from "./api.js";
import { makeKubernetesSocietyPlatform } from "./platform.js";

const SUPPORT_IMAGE =
  "registry.example/simulator@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" satisfies DistributedContainerImage;
const APPLICATION_IMAGE =
  "registry.example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" satisfies DistributedContainerImage;
const ROUTER_URL = Schema.decodeSync(serverBaseUrlSchema)(
  "https://router.run.svc.cluster.local:3000",
);
const runtimeConfiguration = Schema.Struct({ kind: Schema.Literal("fake") });
const WORKLOAD_CREATED = "create:workload";
const WORKLOAD_DELETED = "delete:workload";
const OBSERVED_EXIT_CODE = 17;
const sandboxManifestShape = Schema.Struct({
  spec: Schema.Struct({
    podTemplate: Schema.Struct({
      spec: Schema.Struct({ containers: Schema.Array(Schema.Unknown) }),
    }),
  }),
});

interface FakeKubernetesState {
  admitted: boolean;
  finished: boolean;
  readonly events: string[];
  readonly manifests: KubernetesManifest[];
  readonly workloadObserved: Deferred.Deferred<undefined>;
}

function workload(state: FakeKubernetesState): WorkloadObservation {
  return {
    metadata: { name: "society", generation: 1 },
    status: state.admitted
      ? {
          admission: { clusterQueue: "simulator" },
          conditions: [
            {
              type: "Admitted",
              status: "True",
              observedGeneration: 1,
            },
          ],
        }
      : { conditions: [] },
  };
}

function sandbox(state: FakeKubernetesState, name: string): SandboxObservation {
  return {
    metadata: { name, generation: 1 },
    status: {
      serviceFQDN: `${name}.run.svc.cluster.local`,
      selector: `sandbox=${name}`,
      conditions: state.finished
        ? [
            {
              type: "Finished",
              status: "True",
              observedGeneration: 1,
              reason: "PodFailed",
            },
          ]
        : [
            {
              type: "Ready",
              status: "True",
              observedGeneration: 1,
            },
          ],
    },
  };
}

function pods(state: FakeKubernetesState, selector: string): PodObservation[] {
  const name = selector.slice("sandbox=".length);
  return [
    {
      metadata: { name: `${name}-pod` },
      status: {
        phase: state.finished ? "Failed" : "Running",
        containerStatuses: [
          {
            name: "application",
            restartCount: 0,
            state: state.finished
              ? {
                  terminated: { exitCode: OBSERVED_EXIT_CODE, reason: "Error" },
                }
              : {},
          },
        ],
      },
    },
  ];
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

function fakeApi(state: FakeKubernetesState): KubernetesSocietyApi {
  return {
    createWorkload: (manifest) => record(state, WORKLOAD_CREATED, manifest),
    readWorkload: () =>
      Deferred.succeed(state.workloadObserved, undefined).pipe(
        Effect.zipRight(Effect.sync(() => workload(state))),
      ),
    deleteWorkload: () => record(state, WORKLOAD_DELETED),
    createSecret: (manifest) =>
      record(
        state,
        `create:secret:${String(manifest.metadata instanceof Object && "name" in manifest.metadata ? manifest.metadata.name : "unknown")}`,
        manifest,
      ),
    deleteSecret: (name) => record(state, `delete:secret:${name}`),
    createSandbox: (manifest) =>
      record(
        state,
        `create:sandbox:${String(manifest.metadata instanceof Object && "name" in manifest.metadata ? manifest.metadata.name : "unknown")}`,
        manifest,
      ),
    readSandbox: (name) => Effect.sync(() => sandbox(state, name)),
    deleteSandbox: (name) => record(state, `delete:sandbox:${name}`),
    listPods: (selector) => Effect.sync(() => pods(state, selector)),
    readPodLog: () => Effect.succeed("booting\nconnected as fake-agent\n"),
  };
}

function fakeRuntime() {
  return defineDistributedRuntime({
    name: "fake-container",
    configuration: {
      schema: runtimeConfiguration,
      value: { kind: "fake" as const },
    },
    reservation: {
      image: APPLICATION_IMAGE,
      resources: {
        cpuMillis: 500,
        memoryBytes: 268_435_456,
        ephemeralStorageBytes: 268_435_456,
      },
    },
    render: (input, support) =>
      Effect.succeed({
        applicationContainer: {
          image: APPLICATION_IMAGE,
          entrypoint: ["node", "/application.mjs"],
          environment: { AGENT_NAME: input.agentName },
          ports: [18_789],
          resources: {
            cpuMillis: 500,
            memoryBytes: 268_435_456,
            ephemeralStorageBytes: 268_435_456,
          },
        },
        bootstrapSecret: {
          identity: support.bootstrapSecretIdentity,
          supportImage: support.supportImage,
          files: [
            {
              path: "/var/run/moltzap/bootstrap/config.json",
              content: "TOP-SECRET-CREDENTIAL",
              mode: 0o600,
            },
          ],
        },
        readiness: { outputIncludes: "connected as" },
        attach: ({ termination }) =>
          Effect.succeed({
            gateway: { agentName: input.agentName },
            termination,
          }),
      }),
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

function makeState(
  workloadObserved: Deferred.Deferred<undefined>,
): FakeKubernetesState {
  return {
    admitted: false,
    finished: false,
    events: [],
    manifests: [],
    workloadObserved,
  };
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
      const platform = makeKubernetesSocietyPlatform({
        api: fakeApi(state),
        namespace: "run",
        queueName: "simulator",
        owner: { name: "run-root", uid: "root-uid" },
        supportImage: SUPPORT_IMAGE,
        startupTimeout: Duration.seconds(1),
        pollInterval: Duration.millis(1),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const preparing = yield* Effect.fork(platform.prepare(roster));
          yield* Deferred.await(workloadObserved);
          assert.deepStrictEqual(state.events, [WORKLOAD_CREATED]);
          state.admitted = true;
          const session = yield* Fiber.join(preparing);
          yield* Effect.forEach(
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
          yield* session.cohortReady;
        }),
      ).pipe(
        Effect.timeoutFail({
          duration: Duration.seconds(1),
          onTimeout: () =>
            new Error(`timed out after: ${state.events.join(",")}`),
        }),
      );

      const firstSandbox = state.events.findIndex((event) =>
        event.startsWith("create:sandbox:"),
      );
      const firstSecret = state.events.findIndex((event) =>
        event.startsWith("create:secret:"),
      );
      assert.strictEqual(state.events[0], WORKLOAD_CREATED);
      assert.isAbove(firstSecret, 0);
      assert.isAbove(firstSandbox, firstSecret);
      assert.lengthOf(
        state.events.filter((event) => event.startsWith("create:sandbox:")),
        2,
      );
      assert.lengthOf(
        state.events.filter((event) => event.startsWith("delete:sandbox:")),
        2,
      );
      assert.strictEqual(state.events.at(-1), WORKLOAD_DELETED);

      const sandboxManifests = state.manifests.filter(
        (manifest) => manifest.kind === "Sandbox",
      );
      assert.lengthOf(sandboxManifests, 2);
      for (const manifest of sandboxManifests) {
        assert.notInclude(JSON.stringify(manifest), "TOP-SECRET-CREDENTIAL");
        const decoded =
          Schema.decodeUnknownSync(sandboxManifestShape)(manifest);
        assert.lengthOf(decoded.spec.podTemplate.spec.containers, 1);
      }
    }),
  ));

test("reports a finished Sandbox as runtime evidence without failing platform ownership", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const workloadObserved = yield* Deferred.make<undefined>();
      const state = makeState(workloadObserved);
      state.admitted = true;
      const runtime = fakeRuntime();
      const roster = AgentRoster.make("acme.kubernetes-termination/v1", {
        alice: runtime,
      });
      const platform = makeKubernetesSocietyPlatform({
        api: fakeApi(state),
        namespace: "run",
        queueName: "simulator",
        owner: { name: "run-root", uid: "root-uid" },
        supportImage: SUPPORT_IMAGE,
        startupTimeout: Duration.seconds(1),
        pollInterval: Duration.millis(1),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* platform.prepare(roster);
          const [entry] = roster.validatedDefinitions;
          assert.isDefined(entry);
          const running = yield* session.acquireAgent({
            name: entry.name,
            agentName: entry.agentName,
            runtime: entry.runtime,
            connection: connection(entry.name, 1),
          });
          yield* session.cohortReady;
          const ownership = yield* Effect.fork(session.failure);
          state.finished = true;
          const termination = yield* running.termination;
          assert.instanceOf(termination, RuntimeExited);
          assert.strictEqual(termination.code, OBSERVED_EXIT_CODE);
          yield* Effect.sleep(Duration.millis(5));
          assert.isTrue(Option.isNone(yield* Fiber.poll(ownership)));
        }),
      ).pipe(
        Effect.timeoutFail({
          duration: Duration.seconds(1),
          onTimeout: () =>
            new Error(`timed out after: ${state.events.join(",")}`),
        }),
      );
    }),
  ));

/* eslint-enable max-lines-per-function, max-nested-callbacks, sonarjs/max-lines-per-function -- restore project limits after ordered lifecycle regressions */
