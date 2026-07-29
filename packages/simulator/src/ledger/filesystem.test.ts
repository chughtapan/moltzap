import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import {
  EventCatalog,
  JsonValue,
  LedgerCompletion,
  LedgerManifest,
  LedgerRef,
  LedgerStorage,
  LedgerStorageError,
  type LedgerAllocationInput,
} from "../ledger.js";
import { Deferred, Effect, Exit, Fiber, Option, Ref, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  makeFilesystemLedgerStorage,
  filesystemLedgerStorageLayer,
} from "./filesystem.js";

const it = effectIt.scoped;
const UNSORTED_RECORD = '{"z":1,"a":2}';
const VALID_RECORD = '{"one":1}';
const DURABLE_RECORD = '{"durable":true}';
const RECORDS_ARTIFACT = "records" as const;
const READ_OPERATION = "read" as const;

class StorageEvent extends Schema.TaggedClass<StorageEvent>()(
  "test.storage-event/v1",
  {
    value: Schema.String,
  },
) {}

const TestEvents = EventCatalog.make(StorageEvent);

function allocationInput(): LedgerAllocationInput {
  return {
    definitionId: "test.ledger-storage/v1",
    catalogTags: TestEvents.tags,
    provenance: {
      zeta: "last",
      alpha: "first",
    },
    metadata: {
      scenario: "filesystem-ledger-storage",
      attempt: 1,
    },
  };
}

function expectCanonicalObjects(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      expectCanonicalObjects(entry);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    expect(keys).toEqual([...keys].sort());
    for (const entry of Object.values(value)) {
      expectCanonicalObjects(entry);
    }
  }
}

function verifyRoundTrip() {
  return Effect.gen(function* () {
    const storage = yield* LedgerStorage;
    const allocated = yield* storage.allocate(allocationInput());
    yield* allocated.append(UNSORTED_RECORD);
    const completed = yield* allocated.complete(1);
    const manifestText = yield* storage.read(allocated.ref, "manifest");
    const recordsText = yield* storage.read(allocated.ref, RECORDS_ARTIFACT);
    const completionText = yield* storage.read(allocated.ref, "completion");
    const manifest = yield* Schema.decodeUnknown(
      Schema.parseJson(LedgerManifest),
    )(manifestText);
    const completion = yield* Schema.decodeUnknown(
      Schema.parseJson(LedgerCompletion),
    )(completionText);
    const manifestJson = yield* Schema.decodeUnknown(
      Schema.parseJson(JsonValue),
    )(manifestText);
    const completionJson = yield* Schema.decodeUnknown(
      Schema.parseJson(JsonValue),
    )(completionText);

    expect(manifest.runId).toBe(allocated.runId);
    expect(recordsText).toBe(`${UNSORTED_RECORD}\n`);
    expect(completion).toEqual(completed);
    expect(completion.artifacts.manifest).toBe(
      yield* storage.digest(manifestText),
    );
    expect(completion.artifacts.records).toBe(
      yield* storage.digest(recordsText),
    );
    expect(manifestText.endsWith("\n")).toBe(false);
    expect(completionText.endsWith("\n")).toBe(false);
    expectCanonicalObjects(manifestJson);
    expectCanonicalObjects(completionJson);
  });
}

function roundTripTest() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-ledger-",
    });
    yield* verifyRoundTrip().pipe(
      Effect.provide(filesystemLedgerStorageLayer(root)),
    );
  }).pipe(Effect.provide(NodeContext.layer));
}

function completionIdempotencyTest() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-ledger-complete-",
    });
    const storage = yield* makeFilesystemLedgerStorage(root);
    const allocated = yield* storage.allocate(allocationInput());
    yield* allocated.append('{"sequence":0}');

    const mismatch = yield* allocated.complete(0).pipe(Effect.flip);
    expect(mismatch).toBeInstanceOf(LedgerStorageError);
    const concurrent = yield* Effect.all(
      [allocated.complete(1), allocated.complete(1)],
      { concurrency: 2 },
    );
    const repeated = yield* allocated.complete(1);
    expect(concurrent[0]).toEqual(concurrent[1]);
    expect(repeated).toEqual(concurrent[0]);

    const conflict = yield* allocated.complete(2).pipe(Effect.flip);
    expect(conflict).toBeInstanceOf(LedgerStorageError);
    const lateAppend = yield* allocated
      .append('{"sequence":1}')
      .pipe(Effect.flip);
    expect(lateAppend).toBeInstanceOf(LedgerStorageError);
  }).pipe(Effect.provide(NodeContext.layer));
}

function invalidInputTest() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-ledger-invalid-",
    });
    const storage = yield* makeFilesystemLedgerStorage(root);
    const allocated = yield* storage.allocate(allocationInput());
    const invalidAppend = yield* allocated
      .append('{"one":1}\n{"two":2}')
      .pipe(Effect.flip);
    expect(invalidAppend).toBeInstanceOf(LedgerStorageError);
    yield* allocated.append(VALID_RECORD);
    yield* allocated.complete(1);
    expect(yield* storage.read(allocated.ref, RECORDS_ARTIFACT)).toBe(
      `${VALID_RECORD}\n`,
    );

    const forged = Schema.decodeUnknownSync(LedgerRef)("../outside");
    const invalidRead = yield* storage
      .read(forged, RECORDS_ARTIFACT)
      .pipe(Effect.flip);
    expect(invalidRead).toBeInstanceOf(LedgerStorageError);
    expect(invalidRead.operation).toBe(READ_OPERATION);
    expect(invalidRead.artifact).toBe(RECORDS_ARTIFACT);
  }).pipe(Effect.provide(NodeContext.layer));
}

interface SyncGate {
  readonly armed: Ref.Ref<boolean>;
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly suffix: string;
}

function gatedSync(
  file: FileSystem.File,
  gate: SyncGate,
): Effect.Effect<void, never> {
  return Ref.get(gate.armed).pipe(
    Effect.flatMap((armed) =>
      armed
        ? Deferred.succeed(gate.entered, undefined).pipe(
            Effect.zipRight(Deferred.await(gate.release)),
            Effect.zipRight(file.sync),
            Effect.orDie,
          )
        : file.sync.pipe(Effect.orDie),
    ),
  );
}

function makeGatedFileSystem(
  fileSystem: FileSystem.FileSystem,
  gate: SyncGate,
): FileSystem.FileSystem {
  return {
    ...fileSystem,
    open: (path, options) =>
      fileSystem.open(path, options).pipe(
        Effect.map((file) =>
          path.endsWith(gate.suffix)
            ? {
                [FileSystem.FileTypeId]: FileSystem.FileTypeId,
                fd: file.fd,
                stat: file.stat,
                seek: (offset, from) => file.seek(offset, from),
                sync: gatedSync(file, gate),
                read: (buffer) => file.read(buffer),
                readAlloc: (size) => file.readAlloc(size),
                truncate: (length) => file.truncate(length),
                write: (buffer) => file.write(buffer),
                writeAll: (buffer) => file.writeAll(buffer),
              }
            : file,
        ),
      ),
  };
}

function durableBeforeAckTest() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-ledger-sync-",
    });
    const gate: SyncGate = {
      armed: yield* Ref.make(false),
      entered: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
      suffix: "records.ndjson",
    };
    const storage = yield* makeFilesystemLedgerStorage(root).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        makeGatedFileSystem(fileSystem, gate),
      ),
    );
    const allocated = yield* storage.allocate(allocationInput());
    yield* Ref.set(gate.armed, true);
    const appendFiber = yield* Effect.fork(allocated.append(DURABLE_RECORD));
    yield* Deferred.await(gate.entered);
    expect(Option.isNone(yield* Fiber.poll(appendFiber))).toBe(true);
    const interruption = yield* Effect.fork(Fiber.interrupt(appendFiber));
    yield* Effect.yieldNow();
    expect(Option.isNone(yield* Fiber.poll(interruption))).toBe(true);
    yield* Deferred.succeed(gate.release, undefined);
    const appendExit = yield* Fiber.join(interruption);
    expect(Exit.isInterrupted(appendExit)).toBe(true);
    expect(yield* storage.read(allocated.ref, RECORDS_ARTIFACT)).toBe(
      `${DURABLE_RECORD}\n`,
    );
    yield* allocated.complete(1);
  }).pipe(Effect.provide(NodeContext.layer));
}

function completionInterruptionTest() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-ledger-completion-sync-",
    });
    const gate: SyncGate = {
      armed: yield* Ref.make(false),
      entered: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
      suffix: ".tmp",
    };
    const storage = yield* makeFilesystemLedgerStorage(root).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        makeGatedFileSystem(fileSystem, gate),
      ),
    );
    const allocated = yield* storage.allocate(allocationInput());
    yield* Ref.set(gate.armed, true);
    const completionFiber = yield* Effect.fork(allocated.complete(0));
    yield* Deferred.await(gate.entered);
    const interruption = yield* Effect.fork(Fiber.interrupt(completionFiber));
    yield* Effect.yieldNow();
    expect(Option.isNone(yield* Fiber.poll(interruption))).toBe(true);
    yield* Deferred.succeed(gate.release, undefined);
    const completionExit = yield* Fiber.join(interruption);

    expect(Exit.isInterrupted(completionExit)).toBe(true);
    const repeated = yield* allocated.complete(0);
    expect(repeated.recordCount).toBe(0);
  }).pipe(Effect.provide(NodeContext.layer));
}

describe("filesystem ledger storage", () => {
  it(
    "writes canonical artifacts bound by exact SHA-256 digests",
    roundTripTest,
  );
  it(
    "makes concurrent and repeated exact completion idempotent",
    completionIdempotencyTest,
  );
  it("rejects multi-record appends and path-like references", invalidInputTest);
  it(
    "keeps append durability and state publication atomic under interruption",
    durableBeforeAckTest,
  );
  it(
    "keeps completion publication atomic under interruption",
    completionInterruptionTest,
  );
});
