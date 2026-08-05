/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/no-example-only-tests -- The host installation boundary under test is Promise-native, so its double keeps the same signatures, and these regression-only cases pin the exact rollout arithmetic and bounded availability deadline rather than an invariant over generated input. */

import { expect, it } from "vitest";
import type {
  RunWorkerInstallApi,
  RunWorkerObject,
  WorkerAvailability,
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
      install: (object) => {
        installed.push(object);
        return options.failAt === object
          ? Promise.reject(new Error(`${object} refused`))
          : Promise.resolve();
      },
      readWorkerAvailability: () => {
        const reading = readings[Math.min(read, readings.length - 1)];
        read += 1;
        return reading === undefined
          ? Promise.reject(new Error("no availability was configured"))
          : Promise.resolve(reading);
      },
      wait: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    },
  };
}

it("installs every object exactly once, each after everything it depends on", async () => {
  const { api, installed } = recordingInstall();

  await installRunWorker(api);

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

  await expect(installRunWorker(api)).rejects.toThrow(`${BINDING} refused`);

  expect(installed).not.toContain(WORKLOAD);
});

it("waits for the installed revision rather than the one it replaced", async () => {
  const { api, waits } = recordingInstall({
    availability: [
      // The previous revision is still the only one serving.
      { generation: 4, observedGeneration: 3, availableReplicas: 1 },
      // The new revision is observed but has no replica yet.
      { generation: 4, observedGeneration: 4, availableReplicas: 0 },
      { generation: 4, observedGeneration: 4, availableReplicas: 1 },
    ],
  });

  await installRunWorker(api);

  expect(waits).toEqual([2_000, 2_000]);
});

it("fails the submission when no replica ever becomes available", async () => {
  const { api, waits } = recordingInstall({
    availability: [
      { generation: 1, observedGeneration: 1, availableReplicas: 0 },
    ],
  });

  await expect(installRunWorker(api)).rejects.toBeInstanceOf(
    RunWorkerUnavailable,
  );

  expect(waits).toHaveLength(150);
});

it("reads a rollout as available only once it is both observed and serving", () => {
  expect(workerIsAvailable(AVAILABLE)).toBe(true);
  expect(
    workerIsAvailable({
      generation: 2,
      observedGeneration: 1,
      availableReplicas: 5,
    }),
  ).toBe(false);
  expect(
    workerIsAvailable({
      generation: 2,
      observedGeneration: 2,
      availableReplicas: 0,
    }),
  ).toBe(false);
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/no-example-only-tests -- Restore Effect-first test rules after the Promise-native host installation contract. */
