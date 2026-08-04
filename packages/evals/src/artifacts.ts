/** @file Exact local/GCS retrieval of completed evaluation ledger artifacts. */

import { Command, FileSystem, Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type {
  CompletedLedgerArtifacts,
  LedgerRef,
} from "@moltzap/simulator/ledger";
import { Effect, Either, Schema } from "effect";
import type { SimulatorProfile } from "./submission.js";

const ARTIFACT_FILES = Object.freeze({
  manifest: "manifest.json",
  records: "records.ndjson",
  completion: "completion.json",
} as const);
const bucketName = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u),
);
const decodeBucketName = Schema.decodeUnknownEither(bucketName);
const decodeLedgerDirectory = Schema.decodeUnknownEither(Schema.UUID);

/** Artifact retrieval failed before canonical ledger validation. */
export class EvaluationArtifactReadFailed extends Schema.TaggedError<EvaluationArtifactReadFailed>()(
  "EvaluationArtifactReadFailed",
  {
    profile: Schema.Literal("local", "gke"),
    artifact: Schema.Literal("manifest", "records", "completion"),
    detail: Schema.NonEmptyString,
  },
) {}

/** Replaceable read boundaries used by deterministic retrieval tests. */
export interface EvaluationArtifactOperations<Requirements = never> {
  readonly readFile: (
    path: string,
  ) => Effect.Effect<string, unknown, Requirements>;
  readonly readObject: (
    url: string,
  ) => Effect.Effect<string, unknown, Requirements>;
}

/** Host storage identities for one completed simulator run. */
export interface EvaluationArtifactLocation {
  readonly profile: SimulatorProfile;
  readonly namespace: string;
  readonly ref: LedgerRef;
  readonly localArtifacts?: string;
  readonly gkeArtifactBucket?: string;
}

const liveOperations: EvaluationArtifactOperations<
  FileSystem.FileSystem | CommandExecutor
> = Object.freeze({
  readFile: (path: string) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    ),
  readObject: (url: string) =>
    Command.string(
      Command.make("gcloud", "storage", "cat", url).pipe(
        Command.stderr("inherit"),
      ),
    ),
});

function readFailure(
  location: EvaluationArtifactLocation,
  artifact: keyof typeof ARTIFACT_FILES,
  cause: unknown,
): EvaluationArtifactReadFailed {
  return EvaluationArtifactReadFailed.make({
    profile: location.profile,
    artifact,
    detail: String(cause).trim() || "artifact read failed",
  });
}

function ledgerDirectory(
  location: EvaluationArtifactLocation,
  artifact: keyof typeof ARTIFACT_FILES,
) {
  return Either.match(decodeLedgerDirectory(location.ref), {
    onLeft: (): Effect.Effect<string, EvaluationArtifactReadFailed> =>
      Effect.fail(
        readFailure(
          location,
          artifact,
          "ledger ref is not one UUID path segment",
        ),
      ),
    onRight: (directory): Effect.Effect<string, EvaluationArtifactReadFailed> =>
      Effect.succeed(directory),
  });
}

function localIdentity(
  location: EvaluationArtifactLocation,
  artifact: keyof typeof ARTIFACT_FILES,
  path: Path.Path,
): Effect.Effect<string, EvaluationArtifactReadFailed> {
  const root = location.localArtifacts;
  if (root === undefined || !path.isAbsolute(root)) {
    return Effect.fail(
      readFailure(
        location,
        artifact,
        "MOLTZAP_LOCAL_ARTIFACTS must be an absolute path",
      ),
    );
  }
  return ledgerDirectory(location, artifact).pipe(
    Effect.map((directory) =>
      path.join(
        root,
        location.namespace,
        "ledger",
        directory,
        ARTIFACT_FILES[artifact],
      ),
    ),
  );
}

function gcsIdentity(
  location: EvaluationArtifactLocation,
  artifact: keyof typeof ARTIFACT_FILES,
): Effect.Effect<string, EvaluationArtifactReadFailed> {
  const bucket = location.gkeArtifactBucket;
  if (bucket === undefined) {
    return Effect.fail(
      readFailure(
        location,
        artifact,
        "MOLTZAP_GKE_ARTIFACT_BUCKET must be a valid Cloud Storage bucket",
      ),
    );
  }
  return Either.match(decodeBucketName(bucket), {
    onLeft: (): Effect.Effect<string, EvaluationArtifactReadFailed> =>
      Effect.fail(
        readFailure(
          location,
          artifact,
          "MOLTZAP_GKE_ARTIFACT_BUCKET must be a valid Cloud Storage bucket",
        ),
      ),
    onRight: (
      decodedBucket,
    ): Effect.Effect<string, EvaluationArtifactReadFailed> =>
      ledgerDirectory(location, artifact).pipe(
        Effect.map(
          (directory) =>
            `gs://${decodedBucket}/${encodeURIComponent(location.namespace)}/ledger/${directory}/${ARTIFACT_FILES[artifact]}`,
        ),
      ),
  });
}

function readArtifact<Requirements>(
  location: EvaluationArtifactLocation,
  artifact: keyof typeof ARTIFACT_FILES,
  operations: EvaluationArtifactOperations<Requirements>,
  path: Path.Path,
) {
  const identity =
    location.profile === "local"
      ? localIdentity(location, artifact, path)
      : gcsIdentity(location, artifact);
  return identity.pipe(
    Effect.flatMap((identity) =>
      (location.profile === "local"
        ? operations.readFile(identity)
        : operations.readObject(identity)
      ).pipe(
        Effect.mapError((cause) => readFailure(location, artifact, cause)),
      ),
    ),
  );
}

/**
 * Retrieve the three exact immutable artifacts through injected operations.
 * @param location Profile-owned namespace and ledger identity.
 * @param operations Replaceable local-file and Cloud Storage readers.
 * @returns The three retrieved artifact texts without interpreting them.
 */
export function readEvaluationLedgerArtifactsWith<Requirements = never>(
  location: EvaluationArtifactLocation,
  operations: EvaluationArtifactOperations<Requirements>,
): Effect.Effect<
  CompletedLedgerArtifacts,
  EvaluationArtifactReadFailed,
  Path.Path | Requirements
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const [manifest, records, completion] = yield* Effect.all(
      [
        readArtifact(location, "manifest", operations, path),
        readArtifact(location, "records", operations, path),
        readArtifact(location, "completion", operations, path),
      ] as const,
      { concurrency: 3 },
    );
    return { manifest, records, completion };
  }).pipe(Effect.withSpan("readEvaluationLedgerArtifactsWith"));
}

/**
 * Retrieve completed artifacts from the selected repository-owned profile.
 * @param location Profile-owned namespace and ledger identity.
 * @returns The three artifact texts read through live host operations.
 */
export function readEvaluationLedgerArtifacts(
  location: EvaluationArtifactLocation,
) {
  return readEvaluationLedgerArtifactsWith(location, liveOperations);
}
