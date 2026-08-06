import { createHash, randomUUID, type Hash } from "node:crypto";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import {
  type JsonValue,
  jsonValue,
  LEDGER_FORMAT_VERSION,
  LedgerCompletion,
  ledgerDigest,
  LedgerManifest,
  type LedgerRef,
  ledgerRef,
} from "./schema.js";
import {
  ledgerArtifactFiles,
  LedgerStorage,
  LedgerStorageError,
  type LedgerAllocation,
  type LedgerAllocationInput,
  type LedgerArtifact,
  type LedgerStorageService,
} from "./storage.js";
import { Clock, DateTime, Effect, Layer, Ref, Schema } from "effect";

const encoder = new TextEncoder();

type StorageOperation = LedgerStorageError["operation"];

interface Runtime {
  readonly fileSystem: FileSystem.FileSystem;
  readonly root: string;
}

interface EncodedCompletion {
  readonly completion: LedgerCompletion;
  readonly text: string;
}

type ActivePhase =
  | { readonly _tag: "Open"; readonly recordCount: number }
  | { readonly _tag: "Completing"; readonly candidate: EncodedCompletion }
  | { readonly _tag: "Completed"; readonly completion: LedgerCompletion }
  | { readonly _tag: "Failed"; readonly error: LedgerStorageError };

interface ActiveLedger {
  readonly runtime: Runtime;
  readonly ref: LedgerRef;
  readonly runId: string;
  readonly directory: string;
  readonly manifestDigest: typeof ledgerDigest.Type;
  readonly recordsDigest: Hash;
  readonly phase: Ref.Ref<ActivePhase>;
  readonly transition: Effect.Semaphore;
}

interface ExclusiveWrite {
  readonly path: string;
  readonly text: string;
  readonly operation: StorageOperation;
  readonly ref?: LedgerRef;
  readonly artifact?: LedgerArtifact;
}

interface PreparedAllocation {
  readonly ref: LedgerRef;
  readonly runId: string;
  readonly manifest: LedgerManifest;
  readonly manifestText: string;
  readonly manifestDigest: typeof ledgerDigest.Type;
  readonly directory: string;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function storageError(
  operation: StorageOperation,
  cause: unknown,
  ref?: LedgerRef,
  artifact?: LedgerArtifact,
): LedgerStorageError {
  return LedgerStorageError.make({
    operation,
    detail: describeCause(cause),
    ...(ref === undefined ? {} : { ref }),
    ...(artifact === undefined ? {} : { artifact }),
  });
}

function quote(value: string): string {
  return JSON.stringify(value) ?? '""';
}

function isJsonArray(
  value: readonly JsonValue[] | { readonly [key: string]: JsonValue },
): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function compareKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalComposite(
  value: readonly JsonValue[] | { readonly [key: string]: JsonValue },
): string {
  if (isJsonArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const fields = Object.entries(value)
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([key, entry]) => `${quote(key)}:${canonicalJson(entry)}`);
  return `{${fields.join(",")}}`;
}

function canonicalJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return value === 0 ? "0" : String(value);
  }
  if (typeof value === "string") {
    return quote(value);
  }
  return canonicalComposite(value);
}

function encodeCanonical<S extends Schema.Schema.AnyNoContext>(
  schema: S,
  value: Schema.Schema.Type<S>,
  operation: StorageOperation,
  ref?: LedgerRef,
): Effect.Effect<string, LedgerStorageError> {
  return Schema.encode(schema)(value, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(jsonValue)),
    Effect.map(canonicalJson),
    Effect.mapError((cause) => storageError(operation, cause, ref)),
  );
}

function decodeDigest(
  digest: string,
  operation: StorageOperation,
  ref?: LedgerRef,
): Effect.Effect<typeof ledgerDigest.Type, LedgerStorageError> {
  return Schema.decodeUnknown(ledgerDigest)(digest).pipe(
    Effect.mapError((cause) => storageError(operation, cause, ref)),
  );
}

function digestText(
  text: string,
): Effect.Effect<typeof ledgerDigest.Type, LedgerStorageError> {
  return Effect.try({
    try: () => createHash("sha256").update(text, "utf8").digest("hex"),
    catch: (cause) => storageError("digest", cause),
  }).pipe(Effect.flatMap((digest) => decodeDigest(digest, "digest")));
}

function syncPath(
  runtime: Runtime,
  path: string,
  operation: StorageOperation,
  ref?: LedgerRef,
): Effect.Effect<void, LedgerStorageError> {
  return Effect.scoped(
    runtime.fileSystem
      .open(path, { flag: "r" })
      .pipe(Effect.flatMap((file) => file.sync)),
  ).pipe(Effect.mapError((cause) => storageError(operation, cause, ref)));
}

function writeExclusive(
  runtime: Runtime,
  write: ExclusiveWrite,
): Effect.Effect<void, LedgerStorageError> {
  return writeDurably(runtime, write, "wx");
}

function writeDurably(
  runtime: Runtime,
  write: ExclusiveWrite,
  flag: "w" | "wx",
): Effect.Effect<void, LedgerStorageError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const file = yield* runtime.fileSystem.open(write.path, {
        flag,
      });
      const bytes = encoder.encode(write.text);
      if (bytes.length > 0) {
        yield* file.writeAll(bytes);
      }
      yield* file.sync;
    }),
  ).pipe(
    Effect.mapError((cause) =>
      storageError(write.operation, cause, write.ref, write.artifact),
    ),
  );
}

function appendDurably(
  active: ActiveLedger,
  text: string,
): Effect.Effect<void, LedgerStorageError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const file = yield* active.runtime.fileSystem.open(
        join(active.directory, ledgerArtifactFiles.records),
        { flag: "r+" },
      );
      const info = yield* file.stat;
      yield* file.seek(info.size, "start");
      yield* file.writeAll(encoder.encode(text));
      yield* file.sync;
    }),
  ).pipe(
    Effect.mapError((cause) =>
      storageError("append", cause, active.ref, "records"),
    ),
  );
}

function validateCatalogTags(
  tags: LedgerAllocationInput["catalogTags"],
): Effect.Effect<void, LedgerStorageError> {
  return new Set(tags).size === tags.length
    ? Effect.void
    : Effect.fail(storageError("allocate", "catalogTags must be unique"));
}

function mintRef(): Effect.Effect<LedgerRef, LedgerStorageError> {
  return Schema.decodeUnknown(ledgerRef)(randomUUID()).pipe(
    Effect.mapError((cause) => storageError("allocate", cause)),
  );
}

function mintRunId(ref: LedgerRef): Effect.Effect<string, LedgerStorageError> {
  return Schema.decodeUnknown(Schema.UUID)(randomUUID()).pipe(
    Effect.mapError((cause) => storageError("allocate", cause, ref)),
  );
}

function makeManifest(
  input: LedgerAllocationInput,
  runId: string,
  now: number,
): LedgerManifest {
  return new LedgerManifest({
    ledgerFormatVersion: LEDGER_FORMAT_VERSION,
    definitionId: input.definitionId,
    runId,
    catalogTags: [...input.catalogTags].sort((left, right) =>
      left.localeCompare(right),
    ),
    createdAt: DateTime.unsafeMake(now),
    provenance: input.provenance,
    metadata: input.metadata,
  });
}

function persistAllocation(
  runtime: Runtime,
  prepared: PreparedAllocation,
): Effect.Effect<void, LedgerStorageError> {
  const createDirectory = runtime.fileSystem
    .makeDirectory(prepared.directory)
    .pipe(
      Effect.mapError((cause) => storageError("allocate", cause, prepared.ref)),
    );
  const persistFiles = Effect.gen(function* () {
    yield* syncPath(runtime, runtime.root, "allocate", prepared.ref);
    yield* writeExclusive(runtime, {
      path: join(prepared.directory, ledgerArtifactFiles.manifest),
      text: prepared.manifestText,
      operation: "allocate",
      ref: prepared.ref,
      artifact: "manifest",
    });
    yield* writeExclusive(runtime, {
      path: join(prepared.directory, ledgerArtifactFiles.records),
      text: "",
      operation: "allocate",
      ref: prepared.ref,
      artifact: "records",
    });
    yield* syncPath(runtime, prepared.directory, "allocate", prepared.ref);
  });
  return createDirectory.pipe(
    Effect.zipRight(
      persistFiles.pipe(
        Effect.onError(() =>
          runtime.fileSystem
            .remove(prepared.directory, {
              recursive: true,
              force: true,
            })
            .pipe(Effect.ignore),
        ),
      ),
    ),
  );
}

function prepareAllocation(
  runtime: Runtime,
  input: LedgerAllocationInput,
): Effect.Effect<PreparedAllocation, LedgerStorageError> {
  return Effect.gen(function* () {
    yield* validateCatalogTags(input.catalogTags);
    const ref = yield* mintRef();
    const runId = yield* mintRunId(ref);
    const manifest = makeManifest(input, runId, yield* Clock.currentTimeMillis);
    const manifestText = yield* encodeCanonical(
      LedgerManifest,
      manifest,
      "allocate",
      ref,
    );
    return {
      ref,
      runId,
      manifest,
      manifestText,
      manifestDigest: yield* digestText(manifestText),
      directory: join(runtime.root, ref),
    };
  });
}

function failActive(
  active: ActiveLedger,
  error: LedgerStorageError,
): Effect.Effect<never, LedgerStorageError> {
  return Ref.set<ActivePhase>(active.phase, {
    _tag: "Failed",
    error,
  }).pipe(Effect.zipRight(Effect.fail(error)));
}

function updateRecordsDigest(
  active: ActiveLedger,
  bytes: Uint8Array,
): Effect.Effect<void, LedgerStorageError> {
  return Effect.try({
    try: () => {
      active.recordsDigest.update(bytes);
    },
    catch: (cause) => storageError("append", cause, active.ref, "records"),
  }).pipe(Effect.catchAll((error) => failActive(active, error)));
}

function appendOpen(
  active: ActiveLedger,
  phase: Extract<ActivePhase, { readonly _tag: "Open" }>,
  record: string,
): Effect.Effect<void, LedgerStorageError> {
  const text = `${record}\n`;
  const bytes = encoder.encode(text);
  return appendDurably(active, text).pipe(
    Effect.catchAll((error) => failActive(active, error)),
    Effect.zipRight(updateRecordsDigest(active, bytes)),
    Effect.zipRight(
      Ref.set<ActivePhase>(active.phase, {
        _tag: "Open",
        recordCount: phase.recordCount + 1,
      }),
    ),
  );
}

/**
 * The filesystem API has no append commit token. Callers mask this effect from
 * its first file mutation through the digest and phase update so durable bytes
 * and acknowledged storage state cannot diverge under interruption.
 * @param active Value supplied to the operation.
 * @param record Value supplied to the operation.
 * @returns The append record result.
 */
function appendRecord(
  active: ActiveLedger,
  record: string,
): Effect.Effect<void, LedgerStorageError> {
  if (record.includes("\n") || record.includes("\r")) {
    return Effect.fail(
      storageError(
        "append",
        "one append must contain exactly one NDJSON record",
        active.ref,
        "records",
      ),
    );
  }
  return active.transition.withPermits(1)(
    Effect.uninterruptibleMask((restore) =>
      restore(Ref.get(active.phase)).pipe(
        Effect.flatMap((phase) => {
          switch (phase._tag) {
            case "Open":
              return appendOpen(active, phase, record);
            case "Failed":
              return restore(Effect.fail(phase.error));
            case "Completing":
            case "Completed":
              return restore(
                Effect.fail(
                  storageError(
                    "append",
                    "the ledger is already completing",
                    active.ref,
                    "records",
                  ),
                ),
              );
            default:
              return restore(Effect.dieMessage("Unknown active ledger phase"));
          }
        }),
      ),
    ),
  );
}

function makeCompletionCandidate(
  active: ActiveLedger,
  recordCount: number,
): Effect.Effect<EncodedCompletion, LedgerStorageError> {
  return Effect.gen(function* () {
    const recordsDigest = yield* Effect.try({
      try: () => active.recordsDigest.copy().digest("hex"),
      catch: (cause) => storageError("complete", cause, active.ref, "records"),
    }).pipe(
      Effect.flatMap((digest) => decodeDigest(digest, "complete", active.ref)),
    );
    const completion = new LedgerCompletion({
      ledgerFormatVersion: LEDGER_FORMAT_VERSION,
      runId: active.runId,
      recordCount,
      artifacts: {
        manifest: active.manifestDigest,
        records: recordsDigest,
      },
    });
    return {
      completion,
      text: yield* encodeCanonical(
        LedgerCompletion,
        completion,
        "complete",
        active.ref,
      ),
    };
  });
}

function completionPath(active: ActiveLedger): string {
  return join(active.directory, ledgerArtifactFiles.completion);
}

function completionExists(
  active: ActiveLedger,
): Effect.Effect<boolean, LedgerStorageError> {
  return active.runtime.fileSystem
    .exists(completionPath(active))
    .pipe(
      Effect.mapError((cause) =>
        storageError("complete", cause, active.ref, "completion"),
      ),
    );
}

function matchCompletion(
  active: ActiveLedger,
  candidate: EncodedCompletion,
): Effect.Effect<LedgerCompletion, LedgerStorageError> {
  return active.runtime.fileSystem.readFileString(completionPath(active)).pipe(
    Effect.mapError((cause) =>
      storageError("complete", cause, active.ref, "completion"),
    ),
    Effect.flatMap((existing) =>
      existing === candidate.text
        ? Effect.succeed(candidate.completion)
        : Effect.fail(
            storageError(
              "complete",
              "completion.json already contains different exact bytes",
              active.ref,
              "completion",
            ),
          ),
    ),
    Effect.tap(() =>
      syncPath(active.runtime, active.directory, "complete", active.ref),
    ),
  );
}

function recoverLinkFailure(
  active: ActiveLedger,
  candidate: EncodedCompletion,
  linkError: LedgerStorageError,
): Effect.Effect<LedgerCompletion, LedgerStorageError> {
  return completionExists(active).pipe(
    Effect.flatMap((exists) =>
      exists ? matchCompletion(active, candidate) : Effect.fail(linkError),
    ),
  );
}

function linkCompletion(
  active: ActiveLedger,
  temporary: string,
  candidate: EncodedCompletion,
): Effect.Effect<LedgerCompletion, LedgerStorageError> {
  return active.runtime.fileSystem.link(temporary, completionPath(active)).pipe(
    Effect.mapError((cause) =>
      storageError("complete", cause, active.ref, "completion"),
    ),
    Effect.as(candidate.completion),
    Effect.catchAll((error) => recoverLinkFailure(active, candidate, error)),
    Effect.tap(() =>
      syncPath(active.runtime, active.directory, "complete", active.ref),
    ),
  );
}

function stageCompletion(
  active: ActiveLedger,
  candidate: EncodedCompletion,
): Effect.Effect<LedgerCompletion, LedgerStorageError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* active.runtime.fileSystem
        .makeTempFileScoped({
          directory: active.directory,
          prefix: ".completion-",
          suffix: ".tmp",
        })
        .pipe(
          Effect.mapError((cause) =>
            storageError("complete", cause, active.ref, "completion"),
          ),
        );
      yield* writeDurably(
        active.runtime,
        {
          path: temporary,
          text: candidate.text,
          operation: "complete",
          ref: active.ref,
          artifact: "completion",
        },
        "w",
      );
      yield* syncPath(active.runtime, active.directory, "complete", active.ref);
      return yield* linkCompletion(active, temporary, candidate);
    }),
  );
}

function publishCompletion(
  active: ActiveLedger,
  candidate: EncodedCompletion,
): Effect.Effect<LedgerCompletion, LedgerStorageError> {
  return completionExists(active).pipe(
    Effect.flatMap((exists) =>
      exists
        ? matchCompletion(active, candidate)
        : stageCompletion(active, candidate),
    ),
  );
}

function recordCountConflict(
  active: ActiveLedger,
  expected: number,
  actual: number,
): LedgerStorageError {
  return storageError(
    "complete",
    `recordCount ${String(actual)} does not match ${String(expected)} durable records`,
    active.ref,
    "completion",
  );
}

function prepareOpenCompletion(
  active: ActiveLedger,
  phase: Extract<ActivePhase, { readonly _tag: "Open" }>,
  recordCount: number,
): Effect.Effect<EncodedCompletion, LedgerStorageError> {
  if (recordCount !== phase.recordCount) {
    return Effect.fail(
      recordCountConflict(active, phase.recordCount, recordCount),
    );
  }
  return makeCompletionCandidate(active, recordCount);
}

function prepareExistingCompletion(
  active: ActiveLedger,
  candidate: EncodedCompletion,
  recordCount: number,
): Effect.Effect<EncodedCompletion, LedgerStorageError> {
  if (recordCount !== candidate.completion.recordCount) {
    return Effect.fail(
      recordCountConflict(
        active,
        candidate.completion.recordCount,
        recordCount,
      ),
    );
  }
  return Effect.succeed(candidate);
}

/**
 * Completion publication is one filesystem commit followed by one in-memory
 * handoff. It runs masked because the filesystem API cannot expose the exact
 * instant at which the durable completion link becomes authoritative.
 * @param active Value supplied to the operation.
 * @param candidate Value supplied to the operation.
 * @returns The commit completion result.
 */
function commitCompletion(
  active: ActiveLedger,
  candidate: EncodedCompletion,
): Effect.Effect<LedgerCompletion, LedgerStorageError> {
  return Ref.set<ActivePhase>(active.phase, {
    _tag: "Completing",
    candidate,
  }).pipe(
    Effect.zipRight(publishCompletion(active, candidate)),
    Effect.tap((completion) =>
      Ref.set<ActivePhase>(active.phase, {
        _tag: "Completed",
        completion,
      }),
    ),
  );
}

function completeActive(
  active: ActiveLedger,
  recordCount: number,
): Effect.Effect<LedgerCompletion, LedgerStorageError> {
  return active.transition.withPermits(1)(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const phase = yield* restore(Ref.get(active.phase));
        switch (phase._tag) {
          case "Open": {
            const candidate = yield* restore(
              prepareOpenCompletion(active, phase, recordCount),
            );
            return yield* commitCompletion(active, candidate);
          }
          case "Completing": {
            const candidate = yield* restore(
              prepareExistingCompletion(active, phase.candidate, recordCount),
            );
            return yield* commitCompletion(active, candidate);
          }
          case "Completed":
            return recordCount === phase.completion.recordCount
              ? phase.completion
              : yield* recordCountConflict(
                  active,
                  phase.completion.recordCount,
                  recordCount,
                );
          case "Failed":
            return yield* phase.error;
          default:
            return yield* Effect.dieMessage("Unknown active ledger phase");
        }
      }),
    ),
  );
}

function makeActiveLedger(
  runtime: Runtime,
  prepared: PreparedAllocation,
): Effect.Effect<ActiveLedger> {
  return Effect.gen(function* () {
    return {
      runtime,
      ref: prepared.ref,
      runId: prepared.runId,
      directory: prepared.directory,
      manifestDigest: prepared.manifestDigest,
      recordsDigest: createHash("sha256"),
      phase: yield* Ref.make<ActivePhase>({
        _tag: "Open",
        recordCount: 0,
      }),
      transition: yield* Effect.makeSemaphore(1),
    };
  });
}

function allocate(
  runtime: Runtime,
  input: LedgerAllocationInput,
): Effect.Effect<LedgerAllocation, LedgerStorageError> {
  return Effect.gen(function* () {
    const prepared = yield* prepareAllocation(runtime, input);
    yield* persistAllocation(runtime, prepared);
    const active = yield* makeActiveLedger(runtime, prepared);
    return {
      ref: prepared.ref,
      runId: prepared.runId,
      manifest: prepared.manifest,
      append: (record) => appendRecord(active, record),
      complete: (recordCount) => completeActive(active, recordCount),
    };
  });
}

function artifactPath(
  runtime: Runtime,
  ref: LedgerRef,
  artifact: LedgerArtifact,
): Effect.Effect<string, LedgerStorageError> {
  return Schema.decodeUnknown(Schema.UUID)(ref).pipe(
    Effect.map((uuid) =>
      join(runtime.root, uuid, ledgerArtifactFiles[artifact]),
    ),
    Effect.mapError((cause) =>
      storageError(
        "read",
        `invalid ledger reference: ${cause.message}`,
        ref,
        artifact,
      ),
    ),
  );
}

function readArtifact(
  runtime: Runtime,
  ref: LedgerRef,
  artifact: LedgerArtifact,
): Effect.Effect<string, LedgerStorageError> {
  return artifactPath(runtime, ref, artifact).pipe(
    Effect.flatMap(runtime.fileSystem.readFileString),
    Effect.mapError((cause) =>
      cause instanceof LedgerStorageError
        ? cause
        : storageError("read", cause, ref, artifact),
    ),
  );
}

function initializeRoot(
  runtime: Runtime,
): Effect.Effect<void, LedgerStorageError> {
  return runtime.fileSystem
    .makeDirectory(runtime.root, { recursive: true })
    .pipe(
      Effect.mapError((cause) => storageError("allocate", cause)),
      Effect.zipRight(syncPath(runtime, runtime.root, "allocate")),
    );
}

/**
 * Builds the filesystem implementation of the ledger service.
 *
 * Every append acknowledges only after the records file is fsynced. Completion
 * is an exact canonical marker published atomically after both bound artifacts
 * are durable.
 * @param root Value supplied to the operation.
 * @returns The created filesystem ledger storage.
 */
export function makeFilesystemLedgerStorage(
  root: string,
): Effect.Effect<
  LedgerStorageService,
  LedgerStorageError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const runtime = {
      fileSystem: yield* FileSystem.FileSystem,
      root,
    };
    yield* initializeRoot(runtime);
    const service: LedgerStorageService = {
      allocate: (input: LedgerAllocationInput) => allocate(runtime, input),
      read: (ref: LedgerRef, artifact: LedgerArtifact) =>
        readArtifact(runtime, ref, artifact),
      digest: digestText,
    };
    return service;
  }).pipe(Effect.withSpan("makeFilesystemLedgerStorage"));
}

/**
 * Provides LedgerStorage from one filesystem root.
 * @param root Value supplied to the operation.
 * @returns The filesystem ledger storage layer result.
 */
export function filesystemLedgerStorageLayer(
  root: string,
): Layer.Layer<LedgerStorage, LedgerStorageError, FileSystem.FileSystem> {
  return Layer.effect(LedgerStorage, makeFilesystemLedgerStorage(root));
}
