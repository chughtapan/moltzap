/** @file Exact local/GCS retrieval of completed evaluation ledger artifacts. */

import { Command, FileSystem, Path } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import {
  ledgerArtifactFiles,
  type CompletedLedgerArtifacts,
  type LedgerArtifact,
  type LedgerRef,
} from "@moltzap/simulator/ledger";
import { Brand, Effect, Option, Schema } from "effect";

/**
 * Absolute host directory a local run writes its completed artifacts under.
 * Only `localArtifactRoot` produces one, so no read re-checks absoluteness.
 */
export type LocalArtifactRoot = string & Brand.Brand<"LocalArtifactRoot">;

const asLocalArtifactRoot = Brand.nominal<LocalArtifactRoot>();

const artifactBucket = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u),
  Schema.brand("ArtifactBucket"),
);
/** Cloud Storage bucket a GKE run writes its completed artifacts into. */
export type ArtifactBucket = typeof artifactBucket.Type;

/**
 * A ledger ref is only a storage identity; the profiles that happen to store a
 * ledger under its own directory need one path segment, and a ref carrying a
 * separator or a parent reference would address a neighbouring run instead.
 */
const ledgerDirectory = Schema.UUID.pipe(Schema.brand("LedgerDirectory"));
/** One completed ledger addressed as exactly one storage path segment. */
type LedgerDirectory = typeof ledgerDirectory.Type;

const decodeLedgerDirectory = Schema.decodeUnknownOption(ledgerDirectory);
const decodeArtifactBucket = Schema.decodeUnknownOption(artifactBucket);

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

// The target belongs to the profile, not to a run: a location carrying both an
// optional directory and an optional bucket can be built for a profile whose
// own target was never resolved, and every read then has to re-decide that.
/** Validated artifact target owned by the profile a sweep runs on. */
export type EvaluationArtifactStorage =
  | Readonly<{ profile: "local"; root: LocalArtifactRoot }>
  | Readonly<{ profile: "gke"; bucket: ArtifactBucket }>;

/** Host storage identity for one completed simulator run. */
export interface EvaluationArtifactLocation {
  readonly storage: EvaluationArtifactStorage;
  readonly namespace: string;
  readonly ledger: LedgerDirectory;
}

/**
 * Accept an artifact root only where the host path service calls it absolute.
 * @param path Platform path service that decides absoluteness.
 * @param value Candidate root read from the host environment.
 * @returns The branded root, absent when the candidate is relative.
 */
export function localArtifactRoot(
  path: Path.Path,
  value: string,
): Option.Option<LocalArtifactRoot> {
  return path.isAbsolute(value)
    ? Option.some(asLocalArtifactRoot(value))
    : Option.none();
}

/**
 * Accept a Cloud Storage bucket named the way Cloud Storage names buckets.
 * @param value Candidate bucket read from the host environment.
 * @returns The branded bucket, absent when the name is not one.
 */
export function evaluationArtifactBucket(
  value: string,
): Option.Option<ArtifactBucket> {
  return decodeArtifactBucket(value);
}

/**
 * Address one completed run inside the artifact storage its profile owns.
 * @param storage Validated target owned by the profile the run executed on.
 * @param namespace Run namespace the simulator submitter reported.
 * @param ref Ledger identity the controller committed for the run.
 * @returns The addressed location, absent when the ref is not one segment.
 */
export function evaluationArtifactLocation(
  storage: EvaluationArtifactStorage,
  namespace: string,
  ref: LedgerRef,
): Option.Option<EvaluationArtifactLocation> {
  return decodeLedgerDirectory(ref).pipe(
    Option.map((ledger) => Object.freeze({ storage, namespace, ledger })),
  );
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
  artifact: LedgerArtifact,
  cause: unknown,
): EvaluationArtifactReadFailed {
  return EvaluationArtifactReadFailed.make({
    profile: location.storage.profile,
    artifact,
    detail: String(cause).trim() || "artifact read failed",
  });
}

function localIdentity(
  root: LocalArtifactRoot,
  location: EvaluationArtifactLocation,
  artifact: LedgerArtifact,
  path: Path.Path,
): string {
  return path.join(
    root,
    location.namespace,
    "ledger",
    location.ledger,
    ledgerArtifactFiles[artifact],
  );
}

function gcsIdentity(
  bucket: ArtifactBucket,
  location: EvaluationArtifactLocation,
  artifact: LedgerArtifact,
): string {
  return `gs://${bucket}/${encodeURIComponent(location.namespace)}/ledger/${location.ledger}/${ledgerArtifactFiles[artifact]}`;
}

function readArtifact<Requirements>(
  location: EvaluationArtifactLocation,
  artifact: LedgerArtifact,
  operations: EvaluationArtifactOperations<Requirements>,
  path: Path.Path,
) {
  const storage = location.storage;
  const read =
    storage.profile === "local"
      ? operations.readFile(
          localIdentity(storage.root, location, artifact, path),
        )
      : operations.readObject(gcsIdentity(storage.bucket, location, artifact));
  return read.pipe(
    Effect.mapError((cause) => readFailure(location, artifact, cause)),
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
