import { assert, effect as test } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CompletedLedgerReceipt } from "../../kernel/run.js";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
} from "../../ledger/model.js";
import { programFinishedSummary } from "../controller/summary.js";
import {
  runKubernetesSocietyWith,
  type LocalRunEnvironment,
  type LocalRunResult,
} from "../local/main.js";
import type { RunTemporalSocietyOptions } from "../temporal/run.js";
import {
  gkeExecutionProfileFromConfiguration,
  runGkeSocietyWith,
  type GkeRunOperations,
} from "./main.js";

const PLACEMENT = {
  nodeSelector: { "moltzap.dev/pool": "agents" },
  tolerations: [
    {
      key: "moltzap.dev/agents",
      operator: "Equal",
      value: "true",
      effect: "NoSchedule",
    },
  ],
} as const;
const PROFILE_SOURCE = JSON.stringify({
  apiVersion: "moltzap.gke-profile/v1",
  cluster: { contextEnvironment: "MOLTZAP_KUBE_CONTEXT" },
  rosterPlacement: {
    applyTo: ["aggregateWorkloadPodSets", "sandboxPodTemplates"],
    ...PLACEMENT,
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
const ENVIRONMENT: LocalRunEnvironment = Object.freeze({
  MOLTZAP_CONTROLLER_IMAGE: `controller@sha256:${"a".repeat(64)}`,
  MOLTZAP_GKE_ARTIFACT_BUCKET: "moltzap-artifacts-test",
  MOLTZAP_KUBE_CONTEXT: "gke_project_region_cluster",
  MOLTZAP_TEMPORAL_ADDRESS: "temporal.example:7233",
});
const RUN_UUID = "12345678-1234-4abc-8def-1234567890ab";
const EXPECTED_RUN_ID = `mz-${RUN_UUID.replaceAll("-", "")}`;
const DIGEST = Schema.decodeSync(ledgerDigest)("b".repeat(64));
const RESULT: LocalRunResult = {
  runId: "mz-run",
  namespace: "mz-run",
  result: {
    exitCode: 0,
    summary: programFinishedSummary(
      CompletedLedgerReceipt.make({
        ledger: Schema.decodeSync(ledgerRef)("gke-main-test-ledger"),
        completion: LedgerCompletion.make({
          ledgerFormatVersion: 1,
          runId: "gke-main-test-run",
          recordCount: 0,
          artifacts: { manifest: DIGEST, records: DIGEST },
        }),
      }),
    ),
  },
};

test("binds the checked-in GKE shape to operator-selected identities", () =>
  Effect.sync(() => {
    const profile = gkeExecutionProfileFromConfiguration(
      PROFILE_SOURCE,
      ENVIRONMENT,
    );

    assert.deepStrictEqual(profile, {
      kind: "gke",
      artifactBucket: "moltzap-artifacts-test",
      kubeContext: "gke_project_region_cluster",
      rosterPlacement: PLACEMENT,
    });
  }));

test("submits once through the shared Kubernetes society entry", () =>
  Effect.gen(function* () {
    let observedTemporal: RunTemporalSocietyOptions | undefined;
    const operations: GkeRunOperations = {
      readProfile: () => Effect.succeed(PROFILE_SOURCE),
      runSociety: (args, environment, profile) => {
        return runKubernetesSocietyWith(args, environment, profile, {
          readExperimentModule: () =>
            Effect.succeed("export const runSpec = {};"),
          randomUuid: () => RUN_UUID,
          runTemporalSociety: (options) => {
            observedTemporal = options;
            return Promise.resolve(RESULT.result);
          },
        });
      },
    };

    const result = yield* runGkeSocietyWith(
      ["./experiment.mjs"],
      ENVIRONMENT,
      operations,
    );

    assert.strictEqual(result.runId, EXPECTED_RUN_ID);
    assert.deepStrictEqual(result.result, RESULT.result);
    assert.strictEqual(observedTemporal?.executionProfile?.kind, "gke");
    assert.deepStrictEqual(
      observedTemporal?.executionProfile?.kind === "gke"
        ? observedTemporal.executionProfile.rosterPlacement
        : undefined,
      PLACEMENT,
    );
  }));

test("requires the bucket, explicit kube context, and Temporal endpoint", () =>
  Effect.sync(() => {
    for (const key of [
      "MOLTZAP_GKE_ARTIFACT_BUCKET",
      "MOLTZAP_KUBE_CONTEXT",
      "MOLTZAP_TEMPORAL_ADDRESS",
    ]) {
      assert.throws(() =>
        gkeExecutionProfileFromConfiguration(PROFILE_SOURCE, {
          ...ENVIRONMENT,
          [key]: undefined,
        }),
      );
    }
  }));
