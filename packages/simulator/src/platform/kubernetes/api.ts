/** @file Narrow Kubernetes operations used by one simulator society. */

import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";
import { Effect, Schema } from "effect";
import { SimulatorInfrastructureFailure } from "../failure.js";

const KUEUE_GROUP = "kueue.x-k8s.io";
const KUEUE_VERSION = "v1beta2";
const KUEUE_WORKLOADS = "workloads";
const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1beta1";
const SANDBOXES = "sandboxes";

const condition = Schema.Struct({
  type: Schema.String,
  status: Schema.String,
  observedGeneration: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

const objectMetadata = Schema.Struct({
  name: Schema.String,
  generation: Schema.optional(Schema.Number),
  deletionTimestamp: Schema.optional(Schema.String),
});

const workloadObservation = Schema.Struct({
  metadata: objectMetadata,
  status: Schema.optional(
    Schema.Struct({
      conditions: Schema.optional(Schema.Array(condition)),
      admission: Schema.optional(
        Schema.Struct({
          clusterQueue: Schema.String,
          podSetAssignments: Schema.optional(
            Schema.Array(
              Schema.Struct({
                name: Schema.String,
                flavors: Schema.optional(
                  Schema.Record({ key: Schema.String, value: Schema.String }),
                ),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
});

const sandboxObservation = Schema.Struct({
  metadata: objectMetadata,
  status: Schema.optional(
    Schema.Struct({
      conditions: Schema.optional(Schema.Array(condition)),
      serviceFQDN: Schema.optional(Schema.String),
      selector: Schema.optional(Schema.String),
      podIPs: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

const terminatedContainer = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

const podObservation = Schema.Struct({
  metadata: objectMetadata,
  status: Schema.optional(
    Schema.Struct({
      phase: Schema.optional(Schema.String),
      containerStatuses: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            restartCount: Schema.Number,
            state: Schema.Struct({
              terminated: Schema.optional(terminatedContainer),
            }),
          }),
        ),
      ),
    }),
  ),
});

const podListObservation = Schema.Struct({
  items: Schema.Array(podObservation),
});

/** Minimal condition retained from a Kueue or Agent Sandbox status. */
type KubernetesCondition = typeof condition.Type;

/** Kueue state consumed by aggregate admission and loss checks. */
export type WorkloadObservation = typeof workloadObservation.Type;

/** Agent Sandbox state consumed by readiness and backing-Pod discovery. */
export type SandboxObservation = typeof sandboxObservation.Type;

/** Backing-Pod state consumed by runtime termination observation. */
export type PodObservation = typeof podObservation.Type;

/** Private manifest shape submitted through the custom-object API. */
export type KubernetesManifest = Readonly<Record<string, unknown>>;

/** Exact Kubernetes calls needed by the simulator platform. */
export interface KubernetesSocietyApi {
  readonly createWorkload: (
    manifest: KubernetesManifest,
  ) => Effect.Effect<void, SimulatorInfrastructureFailure>;
  readonly readWorkload: (
    name: string,
  ) => Effect.Effect<WorkloadObservation, SimulatorInfrastructureFailure>;
  readonly deleteWorkload: (
    name: string,
  ) => Effect.Effect<void, SimulatorInfrastructureFailure>;
  readonly createSecret: (
    manifest: KubernetesManifest,
  ) => Effect.Effect<void, SimulatorInfrastructureFailure>;
  readonly deleteSecret: (
    name: string,
  ) => Effect.Effect<void, SimulatorInfrastructureFailure>;
  readonly createSandbox: (
    manifest: KubernetesManifest,
  ) => Effect.Effect<void, SimulatorInfrastructureFailure>;
  readonly readSandbox: (
    name: string,
  ) => Effect.Effect<SandboxObservation, SimulatorInfrastructureFailure>;
  readonly deleteSandbox: (
    name: string,
  ) => Effect.Effect<void, SimulatorInfrastructureFailure>;
  readonly listPods: (
    selector: string,
  ) => Effect.Effect<readonly PodObservation[], SimulatorInfrastructureFailure>;
  readonly readPodLog: (
    name: string,
    container: string,
  ) => Effect.Effect<string, SimulatorInfrastructureFailure>;
}

function infrastructureFailure(
  operation: string,
  cause: unknown,
): SimulatorInfrastructureFailure {
  return new SimulatorInfrastructureFailure({
    detail: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });
}

function request<A>(operation: string, evaluate: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => infrastructureFailure(operation, cause),
  });
}

function decode<A, I, R>(
  operation: string,
  schema: Schema.Schema<A, I, R>,
  value: unknown,
): Effect.Effect<A, SimulatorInfrastructureFailure, R> {
  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((cause) => infrastructureFailure(operation, cause)),
  );
}

function ignoreAbsent(
  operation: string,
  evaluate: () => PromiseLike<unknown>,
): Effect.Effect<void, SimulatorInfrastructureFailure> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      cause instanceof ApiException && cause.code === 404
        ? undefined
        : infrastructureFailure(operation, cause),
  }).pipe(
    Effect.catchAll((failure) =>
      failure === undefined ? Effect.void : Effect.fail(failure),
    ),
    Effect.asVoid,
  );
}

function decodeWorkload(value: unknown) {
  return decode(
    "decode aggregate capacity reservation",
    workloadObservation,
    value,
  );
}

function workloadOperations(
  namespace: string,
  custom: CustomObjectsApi,
): Pick<
  KubernetesSocietyApi,
  "createWorkload" | "readWorkload" | "deleteWorkload"
> {
  return {
    createWorkload: (body) =>
      request("create aggregate capacity reservation", () =>
        custom.createNamespacedCustomObject({
          group: KUEUE_GROUP,
          version: KUEUE_VERSION,
          namespace,
          plural: KUEUE_WORKLOADS,
          body,
          fieldManager: "moltzap-simulator",
          fieldValidation: "Strict",
        }),
      ).pipe(Effect.asVoid),
    readWorkload: (name) =>
      request("observe aggregate capacity reservation", () =>
        custom.getNamespacedCustomObject({
          group: KUEUE_GROUP,
          version: KUEUE_VERSION,
          namespace,
          plural: KUEUE_WORKLOADS,
          name,
        }),
      ).pipe(Effect.flatMap(decodeWorkload)),
    deleteWorkload: (name) =>
      ignoreAbsent("delete aggregate capacity reservation", () =>
        custom.deleteNamespacedCustomObject({
          group: KUEUE_GROUP,
          version: KUEUE_VERSION,
          namespace,
          plural: KUEUE_WORKLOADS,
          name,
          propagationPolicy: "Foreground",
        }),
      ),
  };
}

function coreOperations(
  namespace: string,
  core: CoreV1Api,
): Pick<
  KubernetesSocietyApi,
  "createSecret" | "deleteSecret" | "listPods" | "readPodLog"
> {
  return {
    createSecret: (body) =>
      request("create runtime bootstrap", () =>
        core.createNamespacedSecret({
          namespace,
          body,
          fieldManager: "moltzap-simulator",
          fieldValidation: "Strict",
        }),
      ).pipe(Effect.asVoid),
    deleteSecret: (name) =>
      ignoreAbsent("delete runtime bootstrap", () =>
        core.deleteNamespacedSecret({
          namespace,
          name,
          propagationPolicy: "Foreground",
        }),
      ),
    listPods: (selector) =>
      request("observe sandbox application", () =>
        core.listNamespacedPod({ namespace, labelSelector: selector }),
      ).pipe(
        Effect.flatMap((value) =>
          decode("decode sandbox application", podListObservation, value),
        ),
        Effect.map((value) => value.items),
      ),
    readPodLog: (name, container) =>
      request("read sandbox application readiness", () =>
        core.readNamespacedPodLog({
          namespace,
          name,
          container,
          tailLines: 200,
          limitBytes: 1024 * 1024,
        }),
      ),
  };
}

function sandboxOperations(
  namespace: string,
  custom: CustomObjectsApi,
): Pick<
  KubernetesSocietyApi,
  "createSandbox" | "readSandbox" | "deleteSandbox"
> {
  return {
    createSandbox: (body) =>
      request("create agent sandbox", () =>
        custom.createNamespacedCustomObject({
          group: SANDBOX_GROUP,
          version: SANDBOX_VERSION,
          namespace,
          plural: SANDBOXES,
          body,
          fieldManager: "moltzap-simulator",
          fieldValidation: "Strict",
        }),
      ).pipe(Effect.asVoid),
    readSandbox: (name) =>
      request("observe agent sandbox", () =>
        custom.getNamespacedCustomObject({
          group: SANDBOX_GROUP,
          version: SANDBOX_VERSION,
          namespace,
          plural: SANDBOXES,
          name,
        }),
      ).pipe(
        Effect.flatMap((value) =>
          decode("decode agent sandbox", sandboxObservation, value),
        ),
      ),
    deleteSandbox: (name) =>
      ignoreAbsent("delete agent sandbox", () =>
        custom.deleteNamespacedCustomObject({
          group: SANDBOX_GROUP,
          version: SANDBOX_VERSION,
          namespace,
          plural: SANDBOXES,
          name,
          propagationPolicy: "Foreground",
        }),
      ),
  };
}

/**
 * Build the live in-cluster client without leaking generated API types.
 * @param namespace Namespace that owns the run-scoped resources.
 * @returns Narrow Kubernetes operations consumed by the society platform.
 */
export function makeInClusterKubernetesSocietyApi(
  namespace: string,
): KubernetesSocietyApi {
  const config = new KubeConfig();
  config.loadFromDefault();
  const custom = config.makeApiClient(CustomObjectsApi);
  const core = config.makeApiClient(CoreV1Api);
  return Object.freeze({
    ...workloadOperations(namespace, custom),
    ...coreOperations(namespace, core),
    ...sandboxOperations(namespace, custom),
  });
}

interface ConditionedObservation {
  readonly metadata: { readonly generation?: number };
  readonly status?: { readonly conditions?: readonly KubernetesCondition[] };
}

/**
 * Test whether an object has a positive current-generation condition.
 * @param observation Narrow object status returned by the live decoder.
 * @param type Kubernetes condition type to find.
 * @returns Whether the current generation reports that condition as true.
 */
export function currentConditionIsTrue(
  observation: ConditionedObservation,
  type: string,
): boolean {
  const generation = observation.metadata.generation;
  return (
    observation.status?.conditions?.some(
      (entry) =>
        entry.type === type &&
        entry.status === "True" &&
        (generation === undefined || entry.observedGeneration === generation),
    ) ?? false
  );
}
