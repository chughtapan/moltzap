/** @file GKE entry point for the shared Temporal-managed Kubernetes run. */

import { NodeRuntime } from "@effect/platform-node";
import { Effect, Either, Schema } from "effect";
import { resolve } from "node:path";
import type { KubernetesExecutionProfile } from "../profile.js";
import { ledgerArtifactFiles } from "../../ledger/index.js";
import { isEntryModule } from "../entry.js";
import {
  liveSubmitOperations,
  type RunEnvironment,
  runKubernetesSociety,
  type RunSubmission,
  RunSubmissionError,
  SubmitOperations,
} from "../submit.js";

const PROFILE_PATH = resolve("gke/profile.json");
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u;
const GKE_GCS_FUSE_ANNOTATION = "gke-gcsfuse/volumes";
const GKE_GCS_FUSE_DRIVER = "gcsfuse.csi.storage.gke.io";
const GKE_GCS_FUSE_MOUNT_OPTIONS =
  "uid=1000,gid=1000,file-mode=0640,dir-mode=0750";
const GKE_ACTIVE_LEDGER_PATH = "/var/lib/moltzap/ledger";
const GKE_ARTIFACT_MOUNT_PATH = "/var/lib/moltzap-artifacts";
type GkeKubernetesExecutionProfile = Extract<
  KubernetesExecutionProfile,
  { readonly kind: "gke" }
>;

const runtimeProfileSchema = Schema.Struct({
  apiVersion: Schema.Literal("moltzap.gke-profile/v1"),
  cluster: Schema.Struct({
    contextEnvironment: Schema.Literal("MOLTZAP_KUBE_CONTEXT"),
  }),
  rosterPlacement: Schema.Struct({
    applyTo: Schema.Tuple(
      Schema.Literal("aggregateWorkloadPodSets"),
      Schema.Literal("sandboxPodTemplates"),
    ),
    nodeSelector: Schema.Record({
      key: Schema.NonEmptyString,
      value: Schema.NonEmptyString,
    }),
    tolerations: Schema.Array(
      Schema.Struct({
        key: Schema.NonEmptyString,
        operator: Schema.Literal("Equal"),
        value: Schema.NonEmptyString,
        effect: Schema.Literal("NoSchedule"),
      }),
    ),
  }),
  ledger: Schema.Struct({
    active: Schema.Struct({
      kind: Schema.Literal("empty-dir"),
      volume: Schema.Struct({
        name: Schema.Literal("ledger"),
        emptyDir: Schema.Struct({}),
      }),
      mountPath: Schema.Literal(GKE_ACTIVE_LEDGER_PATH),
      permissionsInitContainer: Schema.Literal(true),
    }),
    retained: Schema.Struct({
      kind: Schema.Literal("gcs-fuse-csi-ephemeral"),
      bucketEnvironment: Schema.Literal("MOLTZAP_GKE_ARTIFACT_BUCKET"),
      podAnnotations: Schema.Struct({
        [GKE_GCS_FUSE_ANNOTATION]: Schema.Literal("true"),
      }),
      volume: Schema.Struct({
        name: Schema.Literal("artifacts"),
        csi: Schema.Struct({
          driver: Schema.Literal(GKE_GCS_FUSE_DRIVER),
          readOnly: Schema.Literal(false),
          volumeAttributes: Schema.Struct({
            mountOptions: Schema.Literal(GKE_GCS_FUSE_MOUNT_OPTIONS),
          }),
        }),
      }),
      mountPath: Schema.Literal(GKE_ARTIFACT_MOUNT_PATH),
      directoryTemplate: Schema.Literal(
        `${GKE_ARTIFACT_MOUNT_PATH}/{runNamespace}/ledger`,
      ),
      publicationOrder: Schema.Tuple(
        Schema.Literal(ledgerArtifactFiles.manifest),
        Schema.Literal(ledgerArtifactFiles.records),
        Schema.Literal(ledgerArtifactFiles.completion),
      ),
    }),
  }),
});
const decodeRuntimeProfile = Schema.decodeEither(
  Schema.parseJson(runtimeProfileSchema),
);

/**
 * Validate the checked-in profile and bind its dynamic cloud identities.
 * @param source Complete checked-in GKE profile JSON.
 * @param environment Operator-selected bucket, context, and Temporal endpoint.
 * @returns The private profile consumed by the existing Temporal path.
 */
export function gkeExecutionProfileFromConfiguration(
  source: string,
  environment: RunEnvironment,
): GkeKubernetesExecutionProfile {
  const profile = checkedRuntimeProfile(source);
  if (
    Object.keys(profile.rosterPlacement.nodeSelector).length === 0 ||
    profile.rosterPlacement.tolerations.length === 0
  ) {
    throw configurationFailure(
      "gke/profile.json must place both capacity and application Pods",
    );
  }

  required(environment, "MOLTZAP_TEMPORAL_ADDRESS");

  return Object.freeze({
    kind: "gke",
    artifactBucket: checkedArtifactBucket(environment),
    kubeContext: required(environment, "MOLTZAP_KUBE_CONTEXT"),
    rosterPlacement: Object.freeze({
      nodeSelector: Object.freeze({
        ...profile.rosterPlacement.nodeSelector,
      }),
      tolerations: Object.freeze(
        profile.rosterPlacement.tolerations.map((toleration) =>
          Object.freeze({ ...toleration }),
        ),
      ),
    }),
  });
}

/**
 * Run one GKE experiment through the same Temporal submission used locally.
 * @param args One `.mjs` RunSpec entrypoint.
 * @param environment GKE identities plus shared image and Temporal settings.
 * @returns The coarse run result and ephemeral run identity.
 */
export function runGkeSociety(
  args: readonly string[],
  environment: RunEnvironment,
): Effect.Effect<RunSubmission, RunSubmissionError, SubmitOperations> {
  return Effect.flatMap(SubmitOperations, (operations) =>
    operations.readTextFile(PROFILE_PATH),
  ).pipe(
    Effect.mapError(() =>
      configurationFailure("gke/profile.json could not be read"),
    ),
    Effect.flatMap((source) =>
      Effect.try({
        try: () => gkeExecutionProfileFromConfiguration(source, environment),
        catch: (cause) =>
          cause instanceof RunSubmissionError
            ? cause
            : configurationFailure("the GKE profile was invalid"),
      }),
    ),
    Effect.flatMap((profile) =>
      runKubernetesSociety(args, environment, profile),
    ),
    Effect.withSpan("runGkeSociety"),
  );
}

function checkedRuntimeProfile(source: string) {
  return Either.match(decodeRuntimeProfile(source), {
    onLeft: () => {
      throw configurationFailure(
        "gke/profile.json does not match the supported execution profile",
      );
    },
    onRight: (value) => value,
  });
}

function checkedArtifactBucket(environment: RunEnvironment): string {
  const artifactBucket = required(environment, "MOLTZAP_GKE_ARTIFACT_BUCKET");
  if (!BUCKET_NAME.test(artifactBucket)) {
    throw configurationFailure(
      "MOLTZAP_GKE_ARTIFACT_BUCKET must be a valid Cloud Storage bucket name",
    );
  }
  return artifactBucket;
}

function required(environment: RunEnvironment, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) {
    throw configurationFailure(`${key} is required by the GKE profile`);
  }
  return value;
}

function configurationFailure(detail: string): RunSubmissionError {
  return new RunSubmissionError({ stage: "configuration", detail });
}

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Direct-entry detection has no Effect Platform equivalent.
if (isEntryModule(import.meta.url, process.argv[1])) {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The executable boundary captures argv once before entering Effect.
  const args = process.argv.slice(2);
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- The executable boundary injects the environment into the typed GKE configuration.
  const environment = process.env;
  runGkeSociety(args, environment).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }),
    ),
    Effect.provide(liveSubmitOperations),
    NodeRuntime.runMain,
  );
}
