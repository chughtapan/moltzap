/**
 * @file Local-filesystem RecordingStore (contract 5 internals): the v0
 * implementation behind the RecordingStore seam. Attempt allocation is
 * an exclusive `mkdir` CAS — a store-global id claim plus the attempt
 * directory — so concurrent runs sharing one store root follow one
 * identity protocol without coordination. The seal path implements the
 * four-step durably-at-most-once protocol from the recording contract:
 * exclusive lock + directory fsync, data fsync, result write, marker
 * tmp+rename.
 *
 * File bytes are the canonical serialization; the reader rejects a
 * manifest whose bytes disagree with the re-encoded decode (a manifest
 * that omits defaulted fields is not the promised fully materialized
 * spec).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Brand, Effect, Schema } from "effect";
import { AttemptId, RunId, wallTimeNow } from "./ids.js";
import { JsonValue, isJsonRecord, serializeJsonCanonical } from "./run-spec.js";
import {
  AlreadySealed,
  ManifestPersistFailed,
  RecordingInvalid,
  RecordingSchemaMismatch,
  RecordingStoreFailed,
  RecordingUnsealed,
  SealFailed,
} from "./errors.js";
import {
  ManifestJson,
  RECORDING_SCHEMA_VERSION,
  RecordingIdentity,
  ResultJson,
  SealMarker,
  TracesJson,
  recordingPath,
  type AllocatedAttempt,
  type RecordingRef,
  type RecordingSnapshot,
  type RecordingStore,
  type SealedRecordingRef,
} from "./recording.js";

const MANIFEST_FILE = "manifest.json";
const EVENTS_FILE = "events.ndjson";
const TRACES_FILE = "traces.json";
const RESULT_FILE = "result.json";
const SEAL_MARKER_FILE = "sealed.json";
const SEAL_LOCK_FILE = "seal.lock";
const SPEC_HASH_PREFIX_LENGTH = 12;
const MAX_ATTEMPT_PROBES = 10_000;
const ATTEMPT_IDS_DIR = ".attempt-ids";

const mintSealedRecordingRef = Brand.nominal<SealedRecordingRef>();

/**
 * Mint the sealed brand from read evidence: the marker's presence in a
 * decoded snapshot IS the sealed state, so a seal-race loser can carry
 * the winner's outcome under the same branded contract. Package-internal;
 * the public mint stays `RecordingStore.seal`.
 */
export function mintSealedFromEvidence(
  ref: RecordingRef,
  snapshot: RecordingSnapshot,
): SealedRecordingRef | undefined {
  return snapshot.seal === undefined ? undefined : mintSealedRecordingRef(ref);
}

type Fs = FileSystem.FileSystem;

const withFs = <A, E>(
  body: (fs: Fs) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.flatMap(FileSystem.FileSystem, body).pipe(
    Effect.provide(NodeContext.layer),
  );

/** Create the v0 local store rooted at `storeRoot`. */
export function makeLocalRecordingStore(storeRoot: string): RecordingStore {
  return {
    allocateAttempt: (identity) => allocateAttempt(storeRoot, identity),
    persistManifest: (manifest) => persistManifest(storeRoot, manifest),
    appendEvents,
    writeTraces,
    seal,
    read,
  };
}

/** The runId format `{specHash12}-s{seed}-{attemptId}` stamped on every event. */
export function runIdFor(
  identity: RecordingIdentity,
  attemptId: AttemptId,
): RunId {
  return Schema.decodeSync(RunId)(
    `${identity.specHash.slice(0, SPEC_HASH_PREFIX_LENGTH)}-s${String(identity.seed)}-${attemptId}`,
  );
}

function storeFailed(file: string): (cause: unknown) => RecordingStoreFailed {
  return (cause) =>
    cause instanceof RecordingStoreFailed
      ? cause
      : new RecordingStoreFailed({
          file,
          message: `The recording store could not access ${file}: ${String(cause)}. Check the store root's filesystem.`,
        });
}

function isErrnoTag(cause: unknown, code: string): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  if ("code" in cause && cause.code === code) return true;
  return "cause" in cause && isErrnoTag(cause.cause, code);
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/** Exclusive mkdir is the allocation CAS: the first creator owns the attempt id. */
function claimAttemptDir(
  fs: Fs,
  path: string,
): Effect.Effect<boolean, RecordingStoreFailed, never> {
  return fs.makeDirectory(path, { recursive: false }).pipe(
    Effect.as(true),
    Effect.catchAll((cause) => {
      if (isErrnoTag(cause, "EEXIST")) return Effect.succeed(false);
      if (isErrnoTag(cause, "ENOENT")) {
        return fs
          .makeDirectory(join(path, ".."), { recursive: true })
          .pipe(Effect.flatMap(() => claimAttemptDir(fs, path)));
      }
      return Effect.fail(cause);
    }),
    Effect.mapError(storeFailed(path)),
  );
}

/**
 * Attempt ids are unique per store root, not merely per identity: the
 * queue's `status`/`cancel`/`retry` take a bare `AttemptId`, so two
 * identities sharing one store must never mint the same id. The
 * store-global claim under `.attempt-ids/` preserves the per-identity
 * monotonicity the recording contract states; attempt numbers under one
 * identity are increasing but not dense.
 */
function allocateAttempt(
  storeRoot: string,
  identity: RecordingIdentity,
): Effect.Effect<AllocatedAttempt, RecordingStoreFailed, never> {
  return withFs((fs) =>
    Effect.gen(function* () {
      for (let n = 1; n <= MAX_ATTEMPT_PROBES; n += 1) {
        const attemptId = Schema.decodeSync(AttemptId)(`a${String(n)}`);
        const idClaim = join(storeRoot, ATTEMPT_IDS_DIR, attemptId);
        if (!(yield* claimAttemptDir(fs, idClaim))) continue;
        const path = recordingPath(storeRoot, identity, attemptId);
        if (yield* claimAttemptDir(fs, path)) {
          return { identity, attemptId, runId: runIdFor(identity, attemptId) };
        }
      }
      return yield* Effect.fail(
        storeFailed(storeRoot)(
          `more than ${String(MAX_ATTEMPT_PROBES)} attempts exist under one store root`,
        ),
      );
    }),
  ).pipe(Effect.withSpan("LocalRecordingStore.allocateAttempt"));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function persistManifest(
  storeRoot: string,
  manifest: ManifestJson,
): Effect.Effect<RecordingRef, ManifestPersistFailed, never> {
  const identity = new RecordingIdentity({
    specHash: manifest.specHash,
    seed: manifest.seed,
  });
  const path = recordingPath(storeRoot, identity, manifest.attemptId);
  const manifestFailed = (cause: unknown): ManifestPersistFailed =>
    new ManifestPersistFailed({
      storeRoot,
      message: `The manifest could not persist under ${path}: ${String(cause)}. No recording exists for this attempt; fix the store root and retry.`,
    });
  return withFs((fs) =>
    fs.makeDirectory(path, { recursive: true }).pipe(
      Effect.zipRight(
        fs.writeFileString(
          join(path, MANIFEST_FILE),
          canonicalBytes(ManifestJson, manifest),
        ),
      ),
      Effect.zipRight(
        fs.writeFileString(join(path, EVENTS_FILE), "", { flag: "a" }),
      ),
      Effect.mapError(manifestFailed),
      Effect.as({
        identity,
        attemptId: manifest.attemptId,
        runId: manifest.runId,
        path,
      }),
    ),
  ).pipe(Effect.withSpan("LocalRecordingStore.persistManifest"));
}

/** Sealed attempts are never overwritten; a write against a marker-bearing directory fails typed. */
function failIfSealed(
  fs: Fs,
  path: string,
  file: string,
): Effect.Effect<void, RecordingStoreFailed, never> {
  return fs.exists(join(path, SEAL_MARKER_FILE)).pipe(
    Effect.mapError(storeFailed(file)),
    Effect.flatMap((sealed) =>
      sealed
        ? Effect.fail(
            storeFailed(file)(
              "the attempt is sealed; sealed recordings are immutable",
            ),
          )
        : Effect.void,
    ),
  );
}

function appendEvents(
  ref: RecordingRef,
  lines: ReadonlyArray<string>,
): Effect.Effect<void, RecordingStoreFailed, never> {
  if (lines.length === 0) return Effect.void;
  return withFs((fs) =>
    failIfSealed(fs, ref.path, EVENTS_FILE).pipe(
      Effect.zipRight(
        fs
          .writeFileString(
            join(ref.path, EVENTS_FILE),
            `${lines.join("\n")}\n`,
            {
              flag: "a",
            },
          )
          .pipe(Effect.mapError(storeFailed(EVENTS_FILE))),
      ),
    ),
  ).pipe(Effect.withSpan("LocalRecordingStore.appendEvents"));
}

function writeTraces(
  ref: RecordingRef,
  traces: TracesJson,
): Effect.Effect<void, RecordingStoreFailed, never> {
  return withFs((fs) =>
    failIfSealed(fs, ref.path, TRACES_FILE).pipe(
      Effect.zipRight(
        fs
          .writeFileString(
            join(ref.path, TRACES_FILE),
            canonicalBytes(TracesJson, traces),
          )
          .pipe(Effect.mapError(storeFailed(TRACES_FILE))),
      ),
    ),
  ).pipe(Effect.withSpan("LocalRecordingStore.writeTraces"));
}

// ---------------------------------------------------------------------------
// Seal protocol
// ---------------------------------------------------------------------------

function sealFailed(
  ref: RecordingRef,
  step: SealFailed["step"],
): (cause: unknown) => SealFailed {
  return (cause) =>
    new SealFailed({
      recordingPath: ref.path,
      step,
      message: `Seal step "${step}" failed: ${String(cause)}. The recording stays unsealed and readable for diagnosis.`,
    });
}

/** Fsync one path (file or directory) so its bytes or directory entry are crash-durable. */
function fsyncPathScoped(
  fs: Fs,
  path: string,
): Effect.Effect<void, PlatformError, never> {
  return Effect.scoped(
    fs.open(path, { flag: "r" }).pipe(Effect.flatMap((file) => file.sync)),
  );
}

/** Step 1: the CAS. O_CREAT|O_EXCL claims the seal; the directory fsync makes the claim crash-durable. */
function acquireSealLock(
  fs: Fs,
  ref: RecordingRef,
): Effect.Effect<void, SealFailed | AlreadySealed, never> {
  const lockPath = join(ref.path, SEAL_LOCK_FILE);
  return Effect.scoped(
    fs.open(lockPath, { flag: "wx" }).pipe(Effect.flatMap((file) => file.sync)),
  ).pipe(
    Effect.catchAll((cause) =>
      isErrnoTag(cause, "EEXIST")
        ? loseSealRace(fs, ref)
        : Effect.fail(sealFailed(ref, "acquire-lock")(cause)),
    ),
    Effect.zipRight(
      fsyncPathScoped(fs, ref.path).pipe(
        Effect.mapError(sealFailed(ref, "acquire-lock")),
      ),
    ),
  );
}

/** The losing racer never writes; `observed` tells the caller whether a sealed outcome exists yet. */
function loseSealRace(
  fs: Fs,
  ref: RecordingRef,
): Effect.Effect<never, SealFailed | AlreadySealed, never> {
  return fs.exists(join(ref.path, SEAL_MARKER_FILE)).pipe(
    Effect.mapError(sealFailed(ref, "acquire-lock")),
    Effect.flatMap((markerPresent) =>
      Effect.fail(
        new AlreadySealed({
          recordingPath: ref.path,
          observed: markerPresent ? "marker-present" : "lock-held",
          message: markerPresent
            ? "The attempt is already sealed; read the winner's single outcome instead of sealing again."
            : "A sealer holds the lock without a marker yet; await marker presence or worker-loss classification. This sealer never writes.",
        }),
      ),
    ),
  );
}

/**
 * Step 2: fsync the three pre-result files. Missing events/traces files
 * materialize empty: an earlier observed store failure still seals, and
 * the digests cover exactly what was written. A missing manifest cannot
 * seal — no manifest, no recording.
 */
function fsyncPreResultFiles(
  fs: Fs,
  ref: RecordingRef,
): Effect.Effect<void, SealFailed, never> {
  return Effect.forEach(
    [EVENTS_FILE, TRACES_FILE],
    (file) => fs.writeFileString(join(ref.path, file), "", { flag: "a" }),
    { concurrency: 1, discard: true },
  ).pipe(
    Effect.zipRight(
      Effect.forEach(
        [MANIFEST_FILE, EVENTS_FILE, TRACES_FILE],
        (file) => fsyncPathScoped(fs, join(ref.path, file)),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.mapError(sealFailed(ref, "fsync-data")),
  );
}

/** Step 3: write result.json and fsync it. */
function writeResult(
  fs: Fs,
  ref: RecordingRef,
  result: ResultJson,
): Effect.Effect<void, SealFailed, never> {
  const path = join(ref.path, RESULT_FILE);
  return fs
    .writeFileString(path, canonicalBytes(ResultJson, result))
    .pipe(
      Effect.zipRight(fsyncPathScoped(fs, path)),
      Effect.mapError(sealFailed(ref, "write-result")),
    );
}

/** Step 4: marker tmp + fsync + atomic rename + directory fsync. */
function publishMarker(
  fs: Fs,
  ref: RecordingRef,
): Effect.Effect<void, SealFailed, never> {
  const tmpPath = join(ref.path, `${SEAL_MARKER_FILE}.tmp`);
  return buildSealMarker(fs, ref).pipe(
    Effect.flatMap((marker) =>
      fs.writeFileString(tmpPath, canonicalBytes(SealMarker, marker)),
    ),
    Effect.zipRight(fsyncPathScoped(fs, tmpPath)),
    Effect.zipRight(fs.rename(tmpPath, join(ref.path, SEAL_MARKER_FILE))),
    Effect.zipRight(fsyncPathScoped(fs, ref.path)),
    Effect.mapError(sealFailed(ref, "write-marker")),
  );
}

function buildSealMarker(
  fs: Fs,
  ref: RecordingRef,
): Effect.Effect<SealMarker, PlatformError, never> {
  return Effect.all(
    [
      digestFile(fs, join(ref.path, MANIFEST_FILE)),
      digestFile(fs, join(ref.path, EVENTS_FILE)),
      digestFile(fs, join(ref.path, TRACES_FILE)),
      digestFile(fs, join(ref.path, RESULT_FILE)),
    ],
    { concurrency: 1 },
  ).pipe(
    Effect.map(
      ([manifest, events, traces, result]) =>
        new SealMarker({
          recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
          runId: ref.runId,
          sealedAtWallTime: wallTimeNow(),
          files: {
            [MANIFEST_FILE]: Schema.decodeSync(Sha256Hex)(manifest),
            [EVENTS_FILE]: Schema.decodeSync(Sha256Hex)(events),
            [TRACES_FILE]: Schema.decodeSync(Sha256Hex)(traces),
            [RESULT_FILE]: Schema.decodeSync(Sha256Hex)(result),
          },
        }),
    ),
  );
}

const Sha256Hex = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));

function digestFile(
  fs: Fs,
  path: string,
): Effect.Effect<string, PlatformError, never> {
  return fs
    .readFile(path)
    .pipe(
      Effect.map((bytes) => createHash("sha256").update(bytes).digest("hex")),
    );
}

function seal(
  ref: RecordingRef,
  result: ResultJson,
): Effect.Effect<SealedRecordingRef, SealFailed | AlreadySealed, never> {
  return withFs((fs) =>
    acquireSealLock(fs, ref).pipe(
      Effect.zipRight(fsyncPreResultFiles(fs, ref)),
      Effect.zipRight(writeResult(fs, ref, result)),
      Effect.zipRight(publishMarker(fs, ref)),
      Effect.as(mintSealedRecordingRef(ref)),
    ),
  ).pipe(Effect.withSpan("LocalRecordingStore.seal"));
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

type ReadError =
  | RecordingStoreFailed
  | RecordingInvalid
  | RecordingSchemaMismatch
  | RecordingUnsealed;

/**
 * Integrity precedes interpretation. The marker's digests are verified
 * before any sealed file is decoded, so a recording whose bytes moved
 * after sealing reports that fact rather than whatever decode error the
 * mutation happens to produce. Reporting "invalid traces.json" about
 * bytes already known to be untrusted tells the reader the wrong thing
 * about which party is at fault.
 */
function read(
  path: string,
): Effect.Effect<RecordingSnapshot, ReadError, never> {
  return withFs((fs) =>
    Effect.gen(function* () {
      const sealMarker = yield* readVersionedFile(
        fs,
        path,
        SEAL_MARKER_FILE,
        SealMarker,
      );
      if (sealMarker !== undefined) {
        yield* verifySealDigests(fs, path, sealMarker);
      }
      const manifest = yield* readManifest(fs, path);
      const events = yield* readEventLines(fs, path);
      const traces = yield* readVersionedFile(
        fs,
        path,
        TRACES_FILE,
        TracesJson,
      );
      const result = yield* readVersionedFile(
        fs,
        path,
        RESULT_FILE,
        ResultJson,
      );
      return { manifest, events, traces, result, seal: sealMarker };
    }),
  ).pipe(Effect.withSpan("LocalRecordingStore.read"));
}

/**
 * The marker's digests are the sealed-completeness evidence: bytes that
 * disagree mean the recording changed after sealing, and the reader
 * rejects it rather than presenting modified files as sealed. The
 * rejection is `RecordingUnsealed`, not a decode failure — the files
 * still parse; what is gone is the guarantee the marker stood for.
 */
function verifySealDigests(
  fs: Fs,
  path: string,
  marker: SealMarker,
): Effect.Effect<void, RecordingStoreFailed | RecordingUnsealed, never> {
  return Effect.forEach(
    Object.entries(marker.files),
    ([file, expected]) =>
      digestFile(fs, join(path, file)).pipe(
        Effect.mapError(storeFailed(file)),
        Effect.filterOrFail(
          (actual) => actual === expected,
          () =>
            new RecordingUnsealed({
              recordingPath: path,
              observed: "digest-mismatch",
              message: `${file} bytes disagree with the digest in ${SEAL_MARKER_FILE}. The recording changed after sealing; sealed files are immutable, so this recording is not gradeable.`,
            }),
        ),
      ),
    { concurrency: 1, discard: true },
  );
}

function readManifest(
  fs: Fs,
  path: string,
): Effect.Effect<ManifestJson, ReadError, never> {
  return readJsonFile(fs, path, MANIFEST_FILE).pipe(
    Effect.flatMap((raw) => {
      if (raw === undefined) {
        return Effect.fail(
          invalidFile(MANIFEST_FILE, "manifest.json is missing", [
            "a recording begins when its manifest persists, so this directory is not a recording",
          ]),
        );
      }
      return checkSchemaVersion(raw, MANIFEST_FILE).pipe(
        Effect.zipRight(decodeRecordingFile(ManifestJson, MANIFEST_FILE, raw)),
        Effect.tap((manifest) => checkManifestFullyMaterialized(raw, manifest)),
      );
    }),
  );
}

function readVersionedFile<A, I>(
  fs: Fs,
  path: string,
  file: string,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A | undefined, ReadError, never> {
  return readJsonFile(fs, path, file).pipe(
    Effect.flatMap((raw) =>
      raw === undefined
        ? Effect.succeed(undefined)
        : checkSchemaVersion(raw, file).pipe(
            Effect.zipRight(decodeRecordingFile(schema, file, raw)),
          ),
    ),
  );
}

/** An empty traces.json (the seal path's placeholder for a failed traces write) reads as absent. */
function readJsonFile(
  fs: Fs,
  dirPath: string,
  file: string,
): Effect.Effect<
  JsonValue | undefined,
  RecordingStoreFailed | RecordingInvalid,
  never
> {
  return fs.readFileString(join(dirPath, file)).pipe(
    Effect.map((text): string | undefined => text),
    Effect.catchAll((cause) =>
      isErrnoTag(cause, "ENOENT")
        ? Effect.succeed(undefined)
        : Effect.fail(storeFailed(file)(cause)),
    ),
    Effect.flatMap((text) =>
      text === undefined || text.length === 0
        ? Effect.succeed(undefined)
        : parseJson(text, file),
    ),
  );
}

function invalidFile(
  file: string,
  message: string,
  details: ReadonlyArray<string>,
): RecordingInvalid {
  return new RecordingInvalid({
    file,
    issues: [{ path: [], message }],
    message: `${file}: ${message}. ${details.join(" ")}`,
  });
}

function parseJson(
  text: string,
  file: string,
): Effect.Effect<JsonValue, RecordingInvalid, never> {
  return Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) =>
      invalidFile(file, String(cause), ["The recording is unreadable."]),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknown(JsonValue)(parsed).pipe(
        Effect.catchTag("ParseError", (cause) =>
          Effect.fail(
            invalidFile(file, cause.message, [
              "The file is outside the JSON value space.",
            ]),
          ),
        ),
      ),
    ),
  );
}

/** Version gate before full decode: graders hard-fail on any other integer. */
function checkSchemaVersion(
  raw: JsonValue,
  file: string,
): Effect.Effect<void, RecordingSchemaMismatch | RecordingInvalid, never> {
  if (!isJsonRecord(raw)) {
    return Effect.fail(
      invalidFile(file, "expected a JSON object", [
        "The recording does not match this reader's schema.",
      ]),
    );
  }
  const version = raw["recordingSchemaVersion"];
  if (version !== RECORDING_SCHEMA_VERSION) {
    return Effect.fail(
      new RecordingSchemaMismatch({
        expected: RECORDING_SCHEMA_VERSION,
        actual: typeof version === "number" ? version : -1,
        message: `${file} carries recordingSchemaVersion ${String(version)}; this reader decodes version ${String(RECORDING_SCHEMA_VERSION)} only. Use a matching reader.`,
      }),
    );
  }
  return Effect.void;
}

function decodeRecordingFile<A, I>(
  schema: Schema.Schema<A, I>,
  file: string,
  raw: JsonValue,
): Effect.Effect<A, RecordingInvalid, never> {
  return Schema.decodeUnknown(schema)(raw).pipe(
    Effect.catchTag("ParseError", (cause) =>
      Effect.fail(
        invalidFile(file, cause.message, [
          "The file does not decode against this reader's schema.",
        ]),
      ),
    ),
  );
}

/**
 * A manifest whose canonical bytes disagree with its re-encoded decode
 * omitted defaulted fields, so it does not persist the promised fully
 * materialized spec; the reader rejects it.
 */
function checkManifestFullyMaterialized(
  raw: JsonValue,
  manifest: ManifestJson,
): Effect.Effect<void, RecordingInvalid, never> {
  const reEncoded = Schema.decodeUnknownSync(JsonValue)(
    Schema.encodeSync(ManifestJson)(manifest),
  );
  if (serializeJsonCanonical(raw) !== serializeJsonCanonical(reEncoded)) {
    return Effect.fail(
      invalidFile(
        MANIFEST_FILE,
        "manifest bytes disagree with the fully materialized re-encoding",
        [
          "The manifest does not persist the fully materialized spec (defaulted fields are missing); regenerate the recording with a conforming writer.",
        ],
      ),
    );
  }
  return Effect.void;
}

function readEventLines(
  fs: Fs,
  path: string,
): Effect.Effect<
  ReadonlyArray<JsonValue>,
  RecordingStoreFailed | RecordingInvalid,
  never
> {
  return fs.readFileString(join(path, EVENTS_FILE)).pipe(
    Effect.map((text): string => text),
    Effect.catchAll((cause) =>
      isErrnoTag(cause, "ENOENT")
        ? Effect.succeed("")
        : Effect.fail(storeFailed(EVENTS_FILE)(cause)),
    ),
    Effect.flatMap((text) =>
      Effect.forEach(
        text.split("\n").filter((line) => line.length > 0),
        (line) => parseJson(line, EVENTS_FILE),
        { concurrency: 1 },
      ),
    ),
  );
}

function canonicalBytes<A, I>(schema: Schema.Schema<A, I>, value: A): string {
  return serializeJsonCanonical(
    Schema.decodeUnknownSync(JsonValue)(Schema.encodeSync(schema)(value)),
  );
}
