/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/no-example-only-tests -- Vitest awaits the Effect the host installation boundary returns, and these regression-only cases pin the exact rollout arithmetic and bounded availability deadline rather than an invariant over generated input. */

import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  KubernetesCallFailed,
  type RunWorkerInstallApi,
  type RunWorkerObject,
  type WorkerAvailability,
} from "./kubernetes/calls.js";
import {
  installRunWorker,
  RunWorkerUnavailable,
  workerIsAvailable,
} from "./install.js";

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

interface RecordedInstall {
  readonly api: RunWorkerInstallApi;
  readonly installed: RunWorkerObject[];
  readonly waits: number[];
}

interface InstallOptions {
  /** Availability readings served in order; the last one repeats forever. */
  readonly availability?: readonly WorkerAvailability[];
  readonly failAt?: RunWorkerObject;
}

function recordingInstall(options: InstallOptions = {}): RecordedInstall {
  const installed: RunWorkerObject[] = [];
  const waits: number[] = [];
  const readings = options.availability ?? [AVAILABLE];
  let read = 0;
  return {
    installed,
    waits,
    api: {
      install: (object) =>
        Effect.suspend(() => {
          installed.push(object);
          return options.failAt === object
            ? Effect.fail(new KubernetesCallFailed(`install ${object}`))
            : Effect.void;
        }),
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

it("installs every object exactly once, each after everything it depends on", async () => {
  const { api, installed } = recordingInstall();

  await Effect.runPromise(installRunWorker(api));

  const byName = (left: string, right: string) => left.localeCompare(right);
  expect([...installed].sort(byName)).toEqual([...EVERY_OBJECT].sort(byName));
  for (const [position, object] of installed.entries()) {
    for (const prerequisite of PREREQUISITES[object]) {
      expect(installed.indexOf(prerequisite)).toBeLessThan(position);
    }
  }
});

it("never installs the workload when its permissions could not be written", async () => {
  const { api, installed } = recordingInstall({ failAt: BINDING });

  const failure = await Effect.runPromise(Effect.flip(installRunWorker(api)));

  expect(failure.message).toBe(`install ${BINDING} failed`);
  expect(installed).not.toContain(WORKLOAD);
});

it("waits for the installed revision rather than the one it replaced", async () => {
  const { api, waits } = recordingInstall({
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

  await Effect.runPromise(installRunWorker(api));

  expect(waits).toEqual([2_000, 2_000]);
});

it("fails the submission when no replica ever becomes available", async () => {
  const { api, waits } = recordingInstall({
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

  const failure = await Effect.runPromise(Effect.flip(installRunWorker(api)));

  expect(failure).toBeInstanceOf(RunWorkerUnavailable);
  expect(waits).toHaveLength(150);
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

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/no-example-only-tests -- Restore Effect-first test rules after the host installation contract. */
