/* eslint-disable agent-code-guard/no-example-only-tests -- regression-only suite: each case pins a distinct durable commit, failure latch, corruption check, or mismatch diagnostic */

import { assert, effect as test } from "@effect/vitest";
import { Chunk, DateTime, Effect, Exit, Fiber, Schema, Stream } from "effect";
import {
  EventCatalog,
  LedgerCompletion,
  LedgerCatalogMismatch,
  LedgerDefinitionMismatch,
  ledgerDigest,
  LedgerInvalid,
  LedgerManifest,
  ledgerRef,
  LedgerStorage,
  LedgerStorageError,
  openLedger,
  type LedgerAllocation,
  type LedgerArtifact,
  type LedgerAllocationInput,
  type LedgerInvalidReason,
  type LedgerStorageService,
} from "../ledger.js";
import { makeRunLedger, type ActiveRunLedger } from "./live.js";

class KernelObserved extends Schema.TaggedClass<KernelObserved>()(
  "moltzap.kernel-observed/v1",
  { detail: Schema.String },
) {}

class CustomerObserved extends Schema.TaggedClass<CustomerObserved>()(
  "acme.customer-observed/v1",
  { secret: Schema.String },
) {}

const coreEvents = EventCatalog.make(KernelObserved);
const customerEvents = EventCatalog.make(CustomerObserved);
const readableEvents = EventCatalog.merge(coreEvents, customerEvents);
const REF = Schema.decodeSync(ledgerRef)("ledger-test");
const DIGEST = Schema.decodeSync(ledgerDigest)("a".repeat(64));
const DEFINITION_ID = "acme.ledger-test/v1";
const SECRET = "private";
const COMPLETION_ARTIFACT = "completion" satisfies LedgerArtifact;
const RECORD_COUNT_MISMATCH =
  "record-count-mismatch" satisfies LedgerInvalidReason;

interface MemoryStorage {
  readonly files: Map<LedgerArtifact, string>;
  readonly service: LedgerStorageService;
}

function storageFailure(
  operation: "append" | "read",
  detail: string,
  artifact?: LedgerArtifact,
): LedgerStorageError {
  return LedgerStorageError.make({
    operation,
    detail,
    ref: REF,
    artifact,
  });
}

function makeManifest(input: LedgerAllocationInput): LedgerManifest {
  return LedgerManifest.make({
    ledgerFormatVersion: 1,
    definitionId: input.definitionId,
    runId: "run-ledger-test",
    catalogTags: [...input.catalogTags].sort((left, right) =>
      left.localeCompare(right),
    ),
    createdAt: DateTime.unsafeMake(0),
    provenance: input.provenance,
    metadata: input.metadata,
  });
}

function persistManifest(
  files: Map<LedgerArtifact, string>,
  manifest: LedgerManifest,
): void {
  files.set(
    "manifest",
    JSON.stringify(Schema.encodeSync(LedgerManifest)(manifest)),
  );
  files.set("records", "");
}

function appendRecords(
  files: Map<LedgerArtifact, string>,
  records: string[],
  failWrites: boolean,
): LedgerAllocation["append"] {
  return (serializedRecord: string) =>
    failWrites
      ? Effect.fail(storageFailure("append", "injected failure"))
      : Effect.sync(() => {
          records.push(serializedRecord);
          files.set("records", `${records.join("\n")}\n`);
        });
}

function completeLedger(files: Map<LedgerArtifact, string>, runId: string) {
  return (recordCount: number) =>
    Effect.sync(() => {
      const completion = LedgerCompletion.make({
        ledgerFormatVersion: 1,
        runId,
        recordCount,
        artifacts: { manifest: DIGEST, records: DIGEST },
      });
      files.set(
        "completion",
        JSON.stringify(Schema.encodeSync(LedgerCompletion)(completion)),
      );
      return completion;
    });
}

function allocateMemoryLedger(
  files: Map<LedgerArtifact, string>,
  records: string[],
  failWrites: boolean,
): LedgerStorageService["allocate"] {
  return (input) => {
    const manifest = makeManifest(input);
    persistManifest(files, manifest);
    return Effect.succeed({
      ref: REF,
      runId: manifest.runId,
      manifest,
      append: appendRecords(files, records, failWrites),
      complete: completeLedger(files, manifest.runId),
    });
  };
}

function readMemoryArtifact(
  files: Map<LedgerArtifact, string>,
): LedgerStorageService["read"] {
  return (...[, artifact]) => {
    const value = files.get(artifact);
    return value === undefined
      ? Effect.fail(storageFailure("read", "missing artifact", artifact))
      : Effect.succeed(value);
  };
}

function makeMemoryStorage(failWrites = false): MemoryStorage {
  const files = new Map<LedgerArtifact, string>();
  const records: string[] = [];
  return {
    files,
    service: {
      allocate: allocateMemoryLedger(files, records, failWrites),
      read: readMemoryArtifact(files),
      digest: () => Effect.succeed(DIGEST),
    },
  };
}

function writeCustomerEvents(active: ActiveRunLedger<typeof readableEvents>) {
  const writer = active.writerFor("program", customerEvents);
  return Effect.forEach(
    [...Array.from({ length: 20 }).keys()],
    (value) =>
      writer.write({
        event: CustomerObserved.make({
          secret: `${SECRET}-${String(value)}`,
        }),
      }),
    { concurrency: 8, discard: true },
  );
}

test("commits original event truth and reopens the same exact-class evidence", () => {
  const memory = makeMemoryStorage();
  const program = Effect.scoped(
    Effect.gen(function* () {
      const active = yield* makeRunLedger(readableEvents, {
        definitionId: DEFINITION_ID,
        provenance: {},
        metadata: {},
      });
      yield* writeCustomerEvents(active);
      yield* active.complete();
      const live = Chunk.toReadonlyArray(
        yield* Stream.runCollect(active.ledger.events(CustomerObserved)),
      );
      const reopened = yield* openLedger(
        readableEvents,
        active.ledger.ref,
        DEFINITION_ID,
      );
      const offline = Chunk.toReadonlyArray(
        yield* Stream.runCollect(reopened.events(CustomerObserved)),
      );

      assert.lengthOf(live, 20);
      assert.deepStrictEqual(offline, live);
      assert.deepStrictEqual(
        live.map((event) => event.secret),
        [...Array.from({ length: 20 }).keys()].map(
          (value) => `${SECRET}-${String(value)}`,
        ),
      );
      const records = Chunk.toReadonlyArray(
        yield* Stream.runCollect(reopened.records),
      );
      assert.deepStrictEqual(
        records.map((record) => record.logicalSequence),
        [...Array.from({ length: 20 }).keys()],
      );
    }),
  );
  return program.pipe(Effect.provideService(LedgerStorage, memory.service));
});

test("latches a durable-write failure for kernel supervision", () => {
  const memory = makeMemoryStorage(true);
  const program = Effect.scoped(
    Effect.gen(function* () {
      const active = yield* makeRunLedger(readableEvents, {
        definitionId: DEFINITION_ID,
        provenance: {},
        metadata: {},
      });
      const failureFiber = yield* Effect.fork(active.failure);
      const writer = active.writerFor("program", customerEvents);
      const writeExit = yield* writer
        .write({
          event: CustomerObserved.make({ secret: SECRET }),
        })
        .pipe(Effect.exit);
      const supervisionExit = yield* Fiber.join(failureFiber).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(writeExit));
      assert.isTrue(Exit.isFailure(supervisionExit));
    }),
  );
  return program.pipe(Effect.provideService(LedgerStorage, memory.service));
});

test("rejects a completion marker whose record count was tampered", () => {
  const memory = makeMemoryStorage();
  const program = Effect.scoped(
    Effect.gen(function* () {
      const active = yield* makeRunLedger(readableEvents, {
        definitionId: DEFINITION_ID,
        provenance: {},
        metadata: {},
      });
      const writer = active.writerFor("program", customerEvents);
      yield* writer.write({
        event: CustomerObserved.make({ secret: SECRET }),
      });
      const completed = yield* active.complete();
      const tampered = LedgerCompletion.make({
        ledgerFormatVersion: completed.ledgerFormatVersion,
        runId: completed.runId,
        recordCount: completed.recordCount + 1,
        artifacts: completed.artifacts,
      });
      memory.files.set(
        COMPLETION_ARTIFACT,
        JSON.stringify(Schema.encodeSync(LedgerCompletion)(tampered)),
      );

      const failure = yield* openLedger(
        readableEvents,
        active.ledger.ref,
        DEFINITION_ID,
      ).pipe(Effect.flip);

      assert.instanceOf(failure, LedgerInvalid);
      assert.strictEqual(failure.artifact, COMPLETION_ARTIFACT);
      assert.strictEqual(failure.reason, RECORD_COUNT_MISMATCH);
    }),
  );
  return program.pipe(Effect.provideService(LedgerStorage, memory.service));
});

test("renders definition and catalog mismatches with both sides", () =>
  Effect.sync(() => {
    const catalog = LedgerCatalogMismatch.make({
      expectedTags: ["acme.expected/v1"],
      actualTags: ["acme.actual/v1"],
    });
    const definition = LedgerDefinitionMismatch.make({
      expectedDefinitionId: "acme.expected/v1",
      actualDefinitionId: "acme.actual/v1",
    });

    assert.include(catalog.message, "acme.expected/v1");
    assert.include(catalog.message, "acme.actual/v1");
    assert.include(definition.message, "acme.expected/v1");
    assert.include(definition.message, "acme.actual/v1");
  }));

/* eslint-enable agent-code-guard/no-example-only-tests -- Restore strict defaults after the scoped file-level exception. */
