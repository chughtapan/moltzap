/** @file The executable routes one command line to one profile and refuses the rest. */

import { assert, effect as test } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { RunControllerResult } from "../reclaim.js";
import type { RunTemporalSocietyOptions } from "../temporal.js";
import {
  type RunEnvironment,
  RunSubmissionError,
  SUBMIT_STAGE,
  SubmitOperations,
  type SubmitOperationsService,
} from "../submit.js";
import { PROFILE_CLI_USAGE, runProfileCli } from "./cli.js";

const DIGEST = "a".repeat(64);
const UUID = "12345678-1234-4abc-8def-1234567890ab";
const EXPECTED_RUN_ID = `mz-${UUID.replaceAll("-", "")}`;
const RESULT: RunControllerResult = {
  exitCode: 1,
  summary: { _tag: "LedgerAllocationFailed" },
};
const PROFILE_SOURCE = JSON.stringify({
  apiVersion: "moltzap.gke-profile/v1",
  cluster: { contextEnvironment: "MOLTZAP_KUBE_CONTEXT" },
  rosterPlacement: {
    applyTo: ["aggregateWorkloadPodSets", "sandboxPodTemplates"],
    nodeSelector: { "moltzap.dev/pool": "agents" },
    tolerations: [
      {
        key: "moltzap.dev/agents",
        operator: "Equal",
        value: "true",
        effect: "NoSchedule",
      },
    ],
  },
  ledger: {
    active: {
      kind: "empty-dir",
      volume: { name: "ledger", emptyDir: {} },
      mountPath: "/var/lib/moltzap/ledger",
      permissionsInitContainer: true,
    },
    retained: {
      kind: "gcs-fuse-csi-ephemeral",
      bucketEnvironment: "MOLTZAP_GKE_ARTIFACT_BUCKET",
      podAnnotations: { "gke-gcsfuse/volumes": "true" },
      volume: {
        name: "artifacts",
        csi: {
          driver: "gcsfuse.csi.storage.gke.io",
          readOnly: false,
          volumeAttributes: {
            mountOptions: "uid=1000,gid=1000,file-mode=0640,dir-mode=0750",
          },
        },
      },
      mountPath: "/var/lib/moltzap-artifacts",
      directoryTemplate: "/var/lib/moltzap-artifacts/{runNamespace}/ledger",
      publicationOrder: ["manifest.json", "records.ndjson", "completion.json"],
    },
  },
});
const LOCAL_ENVIRONMENT: RunEnvironment = Object.freeze({
  MOLTZAP_CONTROLLER_IMAGE: `controller@sha256:${DIGEST}`,
});
const GKE_ENVIRONMENT: RunEnvironment = Object.freeze({
  ...LOCAL_ENVIRONMENT,
  MOLTZAP_GKE_ARTIFACT_BUCKET: "moltzap-artifacts-test",
  MOLTZAP_KUBE_CONTEXT: "gke_project_zone_cluster",
  MOLTZAP_TEMPORAL_ADDRESS: "temporal.example:7233",
});

interface Observed {
  readonly reads: string[];
  readonly submissions: RunTemporalSocietyOptions[];
}

function run(args: readonly string[], environment: RunEnvironment) {
  const observed: Observed = { reads: [], submissions: [] };
  return runProfileCli(args, environment).pipe(
    Effect.provide(Layer.succeed(SubmitOperations, operations(observed))),
    Effect.map((submission) => ({ submission, observed })),
  );
}

function operations(observed: Observed): SubmitOperationsService {
  return {
    readTextFile: (path) =>
      Effect.sync(() => {
        observed.reads.push(path);
        return path.endsWith(".mjs")
          ? "export const runSpec = {};"
          : PROFILE_SOURCE;
      }),
    randomUuid: () => UUID,
    runTemporalSociety: (options) => {
      observed.submissions.push(options);
      return Promise.resolve(RESULT);
    },
  };
}

test("submits through the local profile", () =>
  Effect.gen(function* () {
    const { submission, observed } = yield* run(
      ["run", "--profile", "local", "./experiment.mjs"],
      LOCAL_ENVIRONMENT,
    );

    assert.strictEqual(submission.runId, EXPECTED_RUN_ID);
    assert.deepStrictEqual(submission.result, RESULT);
    assert.strictEqual(
      observed.submissions[0]?.executionProfile?.kind,
      "local",
    );
  }));

test("submits through the GKE profile, reading its checked-in profile", () =>
  Effect.gen(function* () {
    const { submission, observed } = yield* run(
      ["run", "--profile", "gke", "./experiment.mjs"],
      GKE_ENVIRONMENT,
    );

    assert.strictEqual(submission.runId, EXPECTED_RUN_ID);
    assert.strictEqual(observed.submissions[0]?.executionProfile?.kind, "gke");
    assert.isTrue(
      observed.reads.some((path) => path.endsWith("gke/profile.json")),
    );
  }));

test("refuses every other command line before reading anything", () =>
  Effect.gen(function* () {
    for (const args of [
      [],
      ["run"],
      ["run", "--profile", "local"],
      ["run", "--profile", "kind", "./experiment.mjs"],
      ["run", "--profile", "local", "./a.mjs", "./b.mjs"],
      ["submit", "--profile", "local", "./experiment.mjs"],
      ["run", "--cluster", "local", "./experiment.mjs"],
    ]) {
      const observed: Observed = { reads: [], submissions: [] };
      const failure = yield* runProfileCli(args, GKE_ENVIRONMENT).pipe(
        Effect.provide(Layer.succeed(SubmitOperations, operations(observed))),
        Effect.flip,
      );

      assert.instanceOf(failure, RunSubmissionError);
      assert.strictEqual(failure.stage, SUBMIT_STAGE.arguments);
      assert.strictEqual(failure.detail, PROFILE_CLI_USAGE);
      assert.deepStrictEqual(observed.reads, []);
      assert.deepStrictEqual(observed.submissions, []);
    }
  }));
