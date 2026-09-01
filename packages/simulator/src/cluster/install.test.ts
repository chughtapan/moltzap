/** @file Run-worker installation ordering, availability, and guarded rollout regressions. */

import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  FORCE_WORKER_ROLL_VARIABLE,
  installRunWorker,
  type OpenRunReading,
  type RunWorkerInstallRequest,
  RunWorkerRollRefused,
  RunWorkerUnavailable,
  workerIsAvailable,
} from "./install.js";
import {
  KubernetesCallFailed,
  type RunWorkerInstallApi,
  type RunWorkerObject,
  type WorkerAvailability,
} from "./kubernetes/calls.js";

// What each control-plane object needs to already exist when it is installed.
// A Deployment created before its binding starts a Pod whose service account
// cannot delete a run namespace, and the cluster reports that as a permission
// error on some later run rather than as a failed install.
const PREREQUISITES: Readonly<
  Record<RunWorkerObject, readonly RunWorkerObject[]>
> = {
  namespace: [],
  clusterRole: [],
  serviceAccount: ["namespace"],
  clusterRoleBinding: ["clusterRole", "serviceAccount"],
  deployment: ["namespace", "serviceAccount", "clusterRoleBinding"],
};
const EVERY_OBJECT = Object.keys(PREREQUISITES);
const WORKLOAD: RunWorkerObject = "deployment";
const BINDING: RunWorkerObject = "clusterRoleBinding";
const AVAILABLE: WorkerAvailability = {
  generation: 3,
  observedGeneration: 3,
  replicas: 1,
  updatedReplicas: 1,
  availableReplicas: 1,
};

const DESIRED_IMAGE = "registry/controller@sha256:desired";
const INSTALLED_IMAGE = "registry/controller@sha256:installed";
const OPEN_RUN = "mz-0123456789abcdef0123456789abcdef";

interface RecordedInstall {
  readonly api: RunWorkerInstallApi;
  readonly installed: RunWorkerObject[];
  readonly waits: number[];
  /** How many times the roll guard asked Temporal about open runs. */
  readonly queueReads: number[];
}

interface InstallOptions {
  /** Availability readings served in order; the last one repeats forever. */
  readonly availability?: readonly WorkerAvailability[];
  readonly failAt?: RunWorkerObject;
  /** The image the cluster already runs; absent means no worker is installed. */
  readonly installedImage?: string;
}

function recordingInstall(options: InstallOptions = {}): RecordedInstall {
  const installed: RunWorkerObject[] = [];
  const waits: number[] = [];
  const queueReads: number[] = [];
  const readings = options.availability ?? [AVAILABLE];
  let read = 0;
  return {
    installed,
    waits,
    queueReads,
    api: {
      install: (object) =>
        Effect.suspend(() => {
          installed.push(object);
          return options.failAt === object
            ? Effect.fail(new KubernetesCallFailed(`install ${object}`))
            : Effect.void;
        }),
      readInstalledWorkerImage: () => Effect.succeed(options.installedImage),
      readWorkerAvailability: () =>
        Effect.suspend(() => {
          const reading = readings[Math.min(read, readings.length - 1)];
          read += 1;
          return reading === undefined
            ? Effect.fail(
                new KubernetesCallFailed("read a configured availability"),
              )
            : Effect.succeed(reading);
        }),
      wait: (milliseconds) =>
        Effect.sync(() => {
          waits.push(milliseconds);
        }),
    },
  };
}

function install(
  recorded: RecordedInstall,
  options: {
    readonly openRuns?: OpenRunReading;
    readonly forced?: boolean;
  } = {},
) {
  return installRunWorker(recorded.api, request(recorded, options));
}

function request(
  recorded: RecordedInstall,
  options: {
    readonly openRuns?: OpenRunReading;
    readonly forced?: boolean;
  } = {},
): RunWorkerInstallRequest {
  return {
    desiredImage: DESIRED_IMAGE,
    forced: options.forced ?? false,
    readOpenRuns: () =>
      Effect.sync(() => {
        recorded.queueReads.push(recorded.queueReads.length + 1);
        return options.openRuns ?? { _tag: "open", workflowIds: [] };
      }),
  };
}

it("installs every object exactly once, each after everything it depends on", async () => {
  const recorded = recordingInstall();
  const { installed } = recorded;

  await Effect.runPromise(install(recorded));

  const byName = (left: string, right: string) => left.localeCompare(right);
  expect([...installed].sort(byName)).toEqual([...EVERY_OBJECT].sort(byName));
  for (const [position, object] of installed.entries()) {
    for (const prerequisite of PREREQUISITES[object]) {
      expect(installed.indexOf(prerequisite)).toBeLessThan(position);
    }
  }
});

it("never installs the workload when its permissions could not be written", async () => {
  const recorded = recordingInstall({ failAt: BINDING });
  const { installed } = recorded;

  const failure = await Effect.runPromise(Effect.flip(install(recorded)));

  expect(failure.message).toBe(`install ${BINDING} failed`);
  expect(installed).not.toContain(WORKLOAD);
});

it("waits for the installed revision rather than the one it replaced", async () => {
  const recorded = recordingInstall({
    availability: [
      // The previous revision is still the only one serving.
      {
        generation: 4,
        observedGeneration: 3,
        replicas: 2,
        updatedReplicas: 1,
        availableReplicas: 1,
      },
      // The new revision is observed but has no replica yet.
      {
        generation: 4,
        observedGeneration: 4,
        replicas: 1,
        updatedReplicas: 1,
        availableReplicas: 0,
      },
      {
        generation: 4,
        observedGeneration: 4,
        replicas: 1,
        updatedReplicas: 1,
        availableReplicas: 1,
      },
    ],
  });

  await Effect.runPromise(install(recorded));

  expect(recorded.waits).toEqual([2_000, 2_000]);
});

it("fails the submission when no replica ever becomes available", async () => {
  const recorded = recordingInstall({
    availability: [
      {
        generation: 1,
        observedGeneration: 1,
        replicas: 1,
        updatedReplicas: 0,
        availableReplicas: 0,
      },
    ],
  });

  const failure = await Effect.runPromise(Effect.flip(install(recorded)));

  expect(failure).toBeInstanceOf(RunWorkerUnavailable);
  expect(recorded.waits).toHaveLength(150);
});

it("refuses to replace a worker whose queue still has runs open", async () => {
  const recorded = recordingInstall({ installedImage: INSTALLED_IMAGE });

  const failure = await Effect.runPromise(
    Effect.flip(
      install(recorded, {
        openRuns: { _tag: "open", workflowIds: [OPEN_RUN] },
      }),
    ),
  );

  expect(failure).toBeInstanceOf(RunWorkerRollRefused);
  expect(failure.message).toContain(INSTALLED_IMAGE);
  expect(failure.message).toContain(DESIRED_IMAGE);
  expect(failure.message).toContain(OPEN_RUN);
  expect(failure.message).toContain(`${FORCE_WORKER_ROLL_VARIABLE}=1`);
  // Nothing was applied, so the open run keeps the worker that is heartbeating
  // its activity.
  expect(recorded.installed).toEqual([]);
});

// The regression the refusal must never become: submitting the image the
// cluster already runs applies a Pod template it already has, which rolls
// nothing. Refusing there would refuse every ordinary submission made while
// any run is in flight.
it("installs the image the cluster already runs without asking about open runs", async () => {
  const recorded = recordingInstall({ installedImage: DESIRED_IMAGE });

  await Effect.runPromise(
    install(recorded, {
      openRuns: { _tag: "open", workflowIds: [OPEN_RUN] },
    }),
  );

  expect(recorded.installed).toContain(WORKLOAD);
  expect(recorded.queueReads).toEqual([]);
});

it("installs into a cluster that has no worker yet without asking anything", async () => {
  const recorded = recordingInstall();

  await Effect.runPromise(install(recorded));

  expect(recorded.installed).toContain(WORKLOAD);
  expect(recorded.queueReads).toEqual([]);
});

it("rolls a worker with runs open once the operator has forced it", async () => {
  const recorded = recordingInstall({ installedImage: INSTALLED_IMAGE });

  await Effect.runPromise(
    install(recorded, {
      forced: true,
      openRuns: { _tag: "open", workflowIds: [OPEN_RUN] },
    }),
  );

  expect(recorded.installed).toContain(WORKLOAD);
});

// A queue that could not be listed is not an empty queue: reading it as one
// would authorize exactly the roll the refusal exists to prevent.
it("refuses to replace a worker whose open runs could not be read", async () => {
  const recorded = recordingInstall({ installedImage: INSTALLED_IMAGE });

  const failure = await Effect.runPromise(
    Effect.flip(install(recorded, { openRuns: { _tag: "unreadable" } })),
  );

  expect(failure).toBeInstanceOf(RunWorkerRollRefused);
  expect(failure.message).toContain(INSTALLED_IMAGE);
  expect(failure.message).toContain(`${FORCE_WORKER_ROLL_VARIABLE}=1`);
  expect(recorded.installed).toEqual([]);
});

it("replaces a worker whose queue has nothing open", async () => {
  const recorded = recordingInstall({ installedImage: INSTALLED_IMAGE });

  await Effect.runPromise(install(recorded));

  expect(recorded.installed).toContain(WORKLOAD);
  expect(recorded.queueReads).toEqual([1]);
});

it("reads a rollout as available only once it is both observed and serving", () => {
  expect(workerIsAvailable(AVAILABLE)).toBe(true);
  expect(
    workerIsAvailable({
      generation: 2,
      observedGeneration: 1,
      replicas: 5,
      updatedReplicas: 5,
      availableReplicas: 5,
    }),
  ).toBe(false);
  expect(
    workerIsAvailable({
      generation: 2,
      observedGeneration: 2,
      replicas: 1,
      updatedReplicas: 1,
      availableReplicas: 0,
    }),
  ).toBe(false);
  // Mid-rollout: the outgoing revision is still the one serving, so handing it
  // the workflow would lose the activity when the rollout completes.
  expect(
    workerIsAvailable({
      generation: 2,
      observedGeneration: 2,
      replicas: 2,
      updatedReplicas: 1,
      availableReplicas: 1,
    }),
  ).toBe(false);
});
