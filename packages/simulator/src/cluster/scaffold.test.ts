/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- The activity boundary under test is Promise-native, so its double keeps the same signatures. */

import { expect, it } from "vitest";
import type { RunControlApi } from "./kubernetes/calls.js";
import {
  RUN_OWNER_NAME,
  type OwnedRunControlManifests,
} from "./kubernetes/objects.js";
import { LOCAL_KUBERNETES_EXECUTION_PROFILE } from "./profile.js";
import type { RunSocietyWorkflowInput } from "./reclaim.js";
import { prepareRun } from "./scaffold.js";

type PreparationStage = Extract<
  keyof RunControlApi,
  | "createRunRoot"
  | "createExperimentAndQueue"
  | "createControllerAccess"
  | "createRouterService"
  | "startController"
>;

// The run root issues the UID every other object is owned by, and the
// controller acts through the run-scoped RBAC and dials the router Service the
// moment it starts, so it goes last.
const ROOT: PreparationStage = "createRunRoot";
const START: PreparationStage = "startController";
const BEFORE_START: readonly PreparationStage[] = [
  "createRunRoot",
  "createExperimentAndQueue",
  "createControllerAccess",
  "createRouterService",
];
const DIGEST = "a".repeat(64);
const OWNER_UID = "owner-uid-the-cluster-issued";
const INPUT: RunSocietyWorkflowInput = {
  runId: "run-1",
  namespace: "mz-run-1",
  controllerImage: `registry/controller@sha256:${DIGEST}`,
  supportImage: `registry/support@sha256:${DIGEST}`,
  experimentModule: "export const runSpec = society;",
};

interface RecordedRunControl {
  readonly api: RunControlApi;
  readonly calls: PreparationStage[];
  readonly namespaces: string[];
  readonly manifests: OwnedRunControlManifests[];
}

function recordingRunControl(failAt?: PreparationStage): RecordedRunControl {
  const calls: PreparationStage[] = [];
  const namespaces: string[] = [];
  const manifests: OwnedRunControlManifests[] = [];
  const record = (stage: PreparationStage): Promise<void> => {
    calls.push(stage);
    return failAt === stage
      ? Promise.reject(new Error(`${stage} refused`))
      : Promise.resolve();
  };
  const owned =
    (stage: PreparationStage) =>
    (namespace: string, supplied: OwnedRunControlManifests) => {
      namespaces.push(namespace);
      manifests.push(supplied);
      return record(stage);
    };
  return {
    calls,
    namespaces,
    manifests,
    api: {
      createRunRoot: () => {
        calls.push(ROOT);
        return failAt === ROOT
          ? Promise.reject(new Error(`${ROOT} refused`))
          : Promise.resolve(OWNER_UID);
      },
      createExperimentAndQueue: owned("createExperimentAndQueue"),
      createControllerAccess: owned("createControllerAccess"),
      createRouterService: owned("createRouterService"),
      startController: owned(START),
      readControllerJob: () =>
        Promise.reject(new Error("preparing a run observes nothing")),
      readControllerLogs: () => Promise.resolve(undefined),
      deleteRunNamespace: () => Promise.resolve(),
      runNamespaceExists: () => Promise.resolve(false),
    },
  };
}

it("creates the run root before anything it owns and the controller last", async () => {
  const { api, calls, namespaces } = recordingRunControl();

  await prepareRun(api, INPUT, LOCAL_KUBERNETES_EXECUTION_PROFILE);

  expect(calls).toEqual([...BEFORE_START, START]);
  expect(new Set(namespaces)).toEqual(new Set([INPUT.namespace]));
});

it("never starts a controller whose access or endpoint failed to appear", async () => {
  for (const stage of BEFORE_START) {
    const { api, calls } = recordingRunControl(stage);

    await expect(
      prepareRun(api, INPUT, LOCAL_KUBERNETES_EXECUTION_PROFILE),
    ).rejects.toThrow(`${stage} refused`);

    expect(calls).not.toContain(START);
    expect(calls.at(-1)).toBe(stage);
  }
});

it("owns every created object by the run root the cluster just issued", async () => {
  const { api, manifests } = recordingRunControl();

  await prepareRun(api, INPUT, LOCAL_KUBERNETES_EXECUTION_PROFILE);

  const owners = manifests.flatMap((supplied) => [
    supplied.experiment.metadata?.ownerReferences,
    supplied.role.metadata?.ownerReferences,
    supplied.routerService.metadata?.ownerReferences,
    supplied.controllerJob.metadata?.ownerReferences,
  ]);
  expect(owners).not.toHaveLength(0);
  for (const ownerReferences of owners) {
    expect(ownerReferences).toEqual([
      expect.objectContaining({ name: RUN_OWNER_NAME, uid: OWNER_UID }),
    ]);
  }
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first test rules after the Promise-native activity contract. */
