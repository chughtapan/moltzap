/** @file Serialized live-ledger commits, producer-bound writers, streams, and completion. */

import {
  Cause,
  Chunk,
  Clock,
  Deferred,
  Effect,
  Exit,
  Match,
  Option,
  type ParseResult,
  PubSub,
  Queue,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect";
import type {
  EventCatalog,
  EventClass,
  EventClassOf,
  EventOf,
} from "../events/catalog.js";
import {
  type JsonObject,
  type LedgerCompletion,
  type LedgerManifest,
  type LedgerRecord,
  type LedgerRef,
  makeLedgerRecordSchema,
} from "./schema.js";
import {
  type LedgerAllocation,
  LedgerStorage,
  type LedgerStorageError,
} from "./storage.js";

const LEDGER_WAKEUP_CAPACITY = 1;

/** Metadata accompanying one producer-bound event commit. */
interface LedgerWrite<Catalog> {
  readonly event: EventOf<Catalog>;
  readonly causationId?: string;
  readonly correlationId?: string;
}

/** Reports ledger serialization failures. */
export class LedgerSerializationError extends Schema.TaggedError<LedgerSerializationError>()(
  "LedgerSerializationError",
  {
    operation: Schema.Literal("parse", "stringify"),
    cause: Schema.Defect,
  },
) {}

/** Represents ledger failure conditions. */
export type LedgerFailure =
  | LedgerStorageError
  | ParseResult.ParseError
  | LedgerSerializationError;

/** Readable, definition-bound live ledger capability. */
export interface RunLedger<Catalog> {
  readonly ref: LedgerRef;
  readonly manifest: LedgerManifest;
  readonly records: Stream.Stream<LedgerRecord<Catalog>, LedgerFailure>;
  readonly events: <Event extends EventClassOf<Catalog>>(
    eventClass: Event,
  ) => Stream.Stream<Schema.Schema.Type<Event>, LedgerFailure>;
}

/** A writer whose producer identity is fixed by the kernel. */
export interface LedgerWriter<Catalog> {
  readonly write: (
    input: LedgerWrite<Catalog>,
  ) => Effect.Effect<LedgerRecord<Catalog>, LedgerFailure>;
}

interface RunLedgerOptions {
  readonly definitionId: string;
  readonly provenance: JsonObject;
  readonly metadata: JsonObject;
}

/**
 * Kernel-owned side of a live ledger. Programs receive only `ledger` and a
 * separately bound customer-event writer.
 */
export interface ActiveRunLedger<Catalog> {
  readonly ledger: RunLedger<Catalog>;
  readonly failure: Effect.Effect<never, LedgerFailure>;
  readonly writerFor: <
    SubsetSchema extends Schema.Schema.AnyNoContext,
    SubsetClasses extends EventClassOf<Catalog>,
  >(
    producer: string,
    subset: EventCatalog<SubsetSchema, SubsetClasses>,
  ) => LedgerWriter<EventCatalog<SubsetSchema, SubsetClasses>>;
  readonly complete: () => Effect.Effect<LedgerCompletion, LedgerFailure>;
}

type CatalogOf<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
> = EventCatalog<SchemaType, Classes>;

type LedgerPhase =
  | { readonly _tag: "open" }
  | {
      readonly _tag: "completed";
      readonly completion: LedgerCompletion;
    }
  | {
      readonly _tag: "failed";
      readonly cause: Cause.Cause<LedgerFailure>;
    };

interface LedgerRuntime<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
> {
  readonly catalog: CatalogOf<SchemaType, Classes>;
  readonly runId: string;
  readonly startedAtNanos: bigint;

  /**
   * The storage port exposes one durable acknowledgement rather than a
   * separate commit token. The kernel therefore masks this call through live
   * publication so interruption cannot make durable bytes invisible.
   */
  readonly appendStored: (
    serializedRecord: string,
  ) => Effect.Effect<void, LedgerStorageError>;

  /**
   * Completion has the same single-acknowledgement law as append: success
   * means the completion marker is durable.
   */
  readonly completeStored: (
    recordCount: number,
  ) => Effect.Effect<LedgerCompletion, LedgerStorageError>;
  readonly changes: PubSub.PubSub<undefined>;
  readonly history: Ref.Ref<
    Chunk.Chunk<LedgerRecord<CatalogOf<SchemaType, Classes>>>
  >;
  readonly phase: Ref.Ref<LedgerPhase>;
  readonly failure: Deferred.Deferred<never, LedgerFailure>;
  readonly transition: Effect.Semaphore;
}

interface SerializedRecord<WriterCatalog, RuntimeCatalog> {
  readonly record: LedgerRecord<WriterCatalog>;
  readonly committedRecord: LedgerRecord<RuntimeCatalog>;
  readonly bytes: string;
}

interface SerializeRecordRequest<
  WriterSchema extends Schema.Schema.AnyNoContext,
  WriterClasses extends EventClass,
> {
  readonly catalog: EventCatalog<WriterSchema, WriterClasses>;
  readonly producer: string;
  readonly input: LedgerWrite<EventCatalog<WriterSchema, WriterClasses>>;
  readonly logicalSequence: number;
}

interface CommitRequest<
  WriterSchema extends Schema.Schema.AnyNoContext,
  WriterClasses extends EventClass,
> {
  readonly catalog: EventCatalog<WriterSchema, WriterClasses>;
  readonly producer: string;
  readonly input: LedgerWrite<EventCatalog<WriterSchema, WriterClasses>>;
}

/**
 * Allocate one live ledger from the `LedgerStorage` service. The returned
 * kernel capability owns writer binding and completion; its readable member
 * is safe to place in the run's Effect context.
 * @param catalog Complete event catalog accepted by the live ledger.
 * @param options Definition, provenance, and metadata used to allocate storage.
 * @returns The created run ledger.
 */
export function makeRunLedger<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  catalog: EventCatalog<SchemaType, Classes>,
  options: RunLedgerOptions,
): Effect.Effect<
  ActiveRunLedger<CatalogOf<SchemaType, Classes>>,
  LedgerStorageError,
  LedgerStorage | Scope.Scope
> {
  return Effect.gen(function* () {
    const initialized = yield* initializeRunLedger(catalog, options);
    const ledger = makeReadableLedger(initialized);
    return makeActiveLedger(initialized.runtime, ledger);
  }).pipe(Effect.withSpan("makeRunLedger"));
}

/**
 * Select one exact declared event class without exposing an open union.
 * @param catalog Declared catalog that bounds selectable event classes.
 * @param records Ledger record stream to project.
 * @param eventClass Exact declared event class to select.
 * @returns A stream containing decoded events of the selected class.
 */
export function ledgerEvents<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
  Failure,
  Event extends Classes,
>(
  catalog: EventCatalog<SchemaType, Classes>,
  records: Stream.Stream<
    LedgerRecord<EventCatalog<SchemaType, Classes>>,
    Failure
  >,
  eventClass: Event,
): Stream.Stream<Schema.Schema.Type<Event>, Failure> {
  const tag = eventClass._tag;
  if (!catalog.has(eventClass)) {
    return Stream.dieMessage(
      `Event class "${tag}" is outside this ledger catalog`,
    );
  }
  const decode: (input: unknown) => Option.Option<Schema.Schema.Type<Event>> =
    Schema.decodeUnknownOption(eventClass);
  return records.pipe(Stream.filterMap((record) => decode(record.event)));
}

function stringifyJson(
  value: unknown,
): Effect.Effect<string, LedgerSerializationError> {
  return Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) =>
      LedgerSerializationError.make({
        operation: "stringify",
        cause,
      }),
  }).pipe(
    Effect.flatMap((bytes) =>
      bytes === undefined
        ? Effect.fail(
            LedgerSerializationError.make({
              operation: "stringify",
              cause: "the encoded value has no JSON representation",
            }),
          )
        : Effect.succeed(bytes),
    ),
  );
}

function parseJson(
  bytes: string,
): Effect.Effect<unknown, LedgerSerializationError> {
  return Effect.try({
    try: (): unknown => JSON.parse(bytes),
    catch: (cause) =>
      LedgerSerializationError.make({
        operation: "parse",
        cause,
      }),
  });
}

function stampRecord<
  RuntimeSchema extends Schema.Schema.AnyNoContext,
  RuntimeClasses extends EventClass,
  WriterSchema extends Schema.Schema.AnyNoContext,
  WriterClasses extends RuntimeClasses,
>(
  runtime: LedgerRuntime<RuntimeSchema, RuntimeClasses>,
  request: SerializeRecordRequest<WriterSchema, WriterClasses>,
) {
  return Effect.gen(function* () {
    const currentNanos = yield* Clock.currentTimeNanos;
    const observedAt = yield* Clock.currentTimeMillis;
    const elapsedNanos =
      currentNanos < runtime.startedAtNanos
        ? 0n
        : currentNanos - runtime.startedAtNanos;
    const candidate: LedgerRecord<EventCatalog<WriterSchema, WriterClasses>> = {
      runId: runtime.runId,
      eventId: `${runtime.runId}:${String(request.logicalSequence)}`,
      logicalSequence: request.logicalSequence,
      elapsedNanos,
      observedAt,
      producer: request.producer,
      ...(request.input.causationId === undefined
        ? {}
        : { causationId: request.input.causationId }),
      ...(request.input.correlationId === undefined
        ? {}
        : { correlationId: request.input.correlationId }),
      event: request.input.event,
    };
    return candidate;
  });
}

function encodeRecordPair<
  RuntimeSchema extends Schema.Schema.AnyNoContext,
  RuntimeClasses extends EventClass,
  WriterSchema extends Schema.Schema.AnyNoContext,
  WriterClasses extends RuntimeClasses,
>(
  runtime: LedgerRuntime<RuntimeSchema, RuntimeClasses>,
  writerCatalog: EventCatalog<WriterSchema, WriterClasses>,
  candidate: LedgerRecord<EventCatalog<WriterSchema, WriterClasses>>,
) {
  const writerRecordSchema = makeLedgerRecordSchema(writerCatalog);
  const runtimeRecordSchema = makeLedgerRecordSchema(runtime.catalog);
  return Effect.gen(function* () {
    const encoded = yield* Schema.encode(writerRecordSchema)(candidate, {
      onExcessProperty: "error",
    });
    const bytes = yield* stringifyJson(encoded);
    const parsed = yield* parseJson(bytes);
    const record = yield* Schema.decodeUnknown(writerRecordSchema, {
      onExcessProperty: "error",
    })(parsed);
    const committedRecord = yield* Schema.decodeUnknown(runtimeRecordSchema, {
      onExcessProperty: "error",
    })(parsed);
    return { record, committedRecord, bytes };
  });
}

function serializeRecord<
  RuntimeSchema extends Schema.Schema.AnyNoContext,
  RuntimeClasses extends EventClass,
  WriterSchema extends Schema.Schema.AnyNoContext,
  WriterClasses extends RuntimeClasses,
>(
  runtime: LedgerRuntime<RuntimeSchema, RuntimeClasses>,
  request: SerializeRecordRequest<WriterSchema, WriterClasses>,
): Effect.Effect<
  SerializedRecord<
    EventCatalog<WriterSchema, WriterClasses>,
    EventCatalog<RuntimeSchema, RuntimeClasses>
  >,
  LedgerFailure
> {
  return Effect.gen(function* () {
    const candidate = yield* stampRecord(runtime, request);
    return yield* encodeRecordPair(runtime, request.catalog, candidate);
  });
}

function latchFailure<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  runtime: LedgerRuntime<SchemaType, Classes>,
  cause: Cause.Cause<LedgerFailure>,
): Effect.Effect<never, LedgerFailure> {
  return Ref.set(runtime.phase, { _tag: "failed", cause }).pipe(
    Effect.zipRight(Deferred.failCause(runtime.failure, cause)),
    Effect.zipRight(PubSub.publish(runtime.changes, undefined)),
    Effect.zipRight(Effect.failCause(cause)),
  );
}

function requireOpen<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  runtime: LedgerRuntime<SchemaType, Classes>,
): Effect.Effect<void, LedgerFailure> {
  return Ref.get(runtime.phase).pipe(
    Effect.flatMap((phase) =>
      Match.value(phase).pipe(
        Match.tag("failed", (failed) => Effect.failCause(failed.cause)),
        Match.tag("completed", () =>
          Effect.dieMessage(`Ledger "${runtime.runId}" is already complete`),
        ),
        Match.tag("open", () => Effect.void),
        Match.exhaustive,
      ),
    ),
  );
}

function exposeCommit<
  RuntimeSchema extends Schema.Schema.AnyNoContext,
  RuntimeClasses extends EventClass,
  WriterCatalog,
>(
  runtime: LedgerRuntime<RuntimeSchema, RuntimeClasses>,
  serialized: SerializedRecord<
    WriterCatalog,
    EventCatalog<RuntimeSchema, RuntimeClasses>
  >,
): Effect.Effect<LedgerRecord<WriterCatalog>> {
  return Ref.update(
    runtime.history,
    Chunk.append(serialized.committedRecord),
  ).pipe(
    Effect.zipRight(PubSub.publish(runtime.changes, undefined)),
    Effect.as(serialized.record),
  );
}

function writeRecord<
  RuntimeSchema extends Schema.Schema.AnyNoContext,
  RuntimeClasses extends EventClass,
  WriterSchema extends Schema.Schema.AnyNoContext,
  WriterClasses extends RuntimeClasses,
>(
  runtime: LedgerRuntime<RuntimeSchema, RuntimeClasses>,
  writerCatalog: EventCatalog<WriterSchema, WriterClasses>,
  producer: string,
  input: LedgerWrite<EventCatalog<WriterSchema, WriterClasses>>,
): Effect.Effect<
  LedgerRecord<EventCatalog<WriterSchema, WriterClasses>>,
  LedgerFailure
> {
  return runtime.transition
    .withPermits(1)(
      commitRecord(runtime, { catalog: writerCatalog, producer, input }),
    )
    .pipe(Effect.withSpan("RunLedger.write"));
}

function commitRecord<
  RuntimeSchema extends Schema.Schema.AnyNoContext,
  RuntimeClasses extends EventClass,
  WriterSchema extends Schema.Schema.AnyNoContext,
  WriterClasses extends RuntimeClasses,
>(
  runtime: LedgerRuntime<RuntimeSchema, RuntimeClasses>,
  request: CommitRequest<WriterSchema, WriterClasses>,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* restore(requireOpen(runtime));
      const logicalSequence = Chunk.size(
        yield* restore(Ref.get(runtime.history)),
      );
      const serialized = yield* Effect.exit(
        restore(
          serializeRecord(runtime, {
            catalog: request.catalog,
            producer: request.producer,
            input: request.input,
            logicalSequence,
          }),
        ),
      );
      if (Exit.isFailure(serialized)) {
        if (Cause.isInterruptedOnly(serialized.cause)) {
          return yield* Effect.failCause(serialized.cause);
        }
        return yield* latchFailure(runtime, serialized.cause);
      }
      const stored = yield* Effect.exit(
        runtime.appendStored(serialized.value.bytes),
      );
      if (Exit.isFailure(stored)) {
        return yield* latchFailure(runtime, stored.cause);
      }
      return yield* exposeCommit(runtime, serialized.value);
    }),
  );
}

type CursorRead<Catalog> =
  | {
      readonly _tag: "records";
      readonly records: Chunk.Chunk<LedgerRecord<Catalog>>;
    }
  | { readonly _tag: "wait" }
  | { readonly _tag: "end" }
  | {
      readonly _tag: "failed";
      readonly cause: Cause.Cause<LedgerFailure>;
    };

function readNextChunk<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  runtime: LedgerRuntime<SchemaType, Classes>,
  changes: Queue.Dequeue<undefined>,
  cursor: Ref.Ref<number>,
): Effect.Effect<
  Chunk.Chunk<LedgerRecord<CatalogOf<SchemaType, Classes>>>,
  Option.Option<LedgerFailure>
> {
  return runtime.transition
    .withPermits(1)(readCursor(runtime, cursor))
    .pipe(
      Effect.flatMap((read) =>
        Match.value(read).pipe(
          Match.tag("records", ({ records }) => Effect.succeed(records)),
          Match.tag("end", () => Effect.fail(Option.none())),
          Match.tag("failed", ({ cause }) =>
            Effect.failCause(Cause.map(cause, Option.some)),
          ),
          Match.tag("wait", () =>
            Queue.take(changes).pipe(
              Effect.zipRight(
                Effect.suspend(() => readNextChunk(runtime, changes, cursor)),
              ),
            ),
          ),
          Match.exhaustive,
        ),
      ),
    );
}

function readCursor<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  runtime: LedgerRuntime<SchemaType, Classes>,
  cursor: Ref.Ref<number>,
): Effect.Effect<CursorRead<CatalogOf<SchemaType, Classes>>> {
  return Effect.gen(function* () {
    const committed = yield* Ref.get(runtime.history);
    const next = yield* Ref.get(cursor);
    const available = Chunk.drop(committed, next);
    if (Chunk.isNonEmpty(available)) {
      yield* Ref.set(cursor, Chunk.size(committed));
      return { _tag: "records", records: available };
    }
    const phase = yield* Ref.get(runtime.phase);
    return Match.value(phase).pipe(
      Match.tag("completed", () => ({ _tag: "end" as const })),
      Match.tag("failed", (failed) => ({
        _tag: "failed" as const,
        cause: failed.cause,
      })),
      Match.tag("open", () => ({ _tag: "wait" as const })),
      Match.exhaustive,
    );
  });
}

function makeReadableLedger<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  initialized: InitializedRunLedger<SchemaType, Classes>,
): RunLedger<CatalogOf<SchemaType, Classes>> {
  const { allocation, runtime } = initialized;
  const records = recordStream(runtime);
  return {
    ref: allocation.ref,
    manifest: allocation.manifest,
    records,
    events: (eventClass) => ledgerEvents(runtime.catalog, records, eventClass),
  };
}

function recordStream<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  runtime: LedgerRuntime<SchemaType, Classes>,
): Stream.Stream<LedgerRecord<CatalogOf<SchemaType, Classes>>, LedgerFailure> {
  return Stream.unwrapScoped(
    runtime.transition.withPermits(1)(snapshotRecords(runtime)),
  );
}

function snapshotRecords<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  runtime: LedgerRuntime<SchemaType, Classes>,
): Effect.Effect<
  Stream.Stream<LedgerRecord<CatalogOf<SchemaType, Classes>>, LedgerFailure>,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const changes = yield* PubSub.subscribe(runtime.changes);
    const cursor = yield* Ref.make(0);
    return Stream.repeatEffectChunkOption(
      readNextChunk(runtime, changes, cursor),
    );
  });
}

function isCatalogSubset<
  RuntimeSchema extends Schema.Schema.AnyNoContext,
  RuntimeClasses extends EventClass,
  SubsetSchema extends Schema.Schema.AnyNoContext,
  SubsetClasses extends RuntimeClasses,
>(
  catalog: EventCatalog<RuntimeSchema, RuntimeClasses>,
  subset: EventCatalog<SubsetSchema, SubsetClasses>,
): boolean {
  for (const eventClass of subset.eventClasses) {
    if (!catalog.has(eventClass)) {
      return false;
    }
  }
  return true;
}

function completeLedger<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  runtime: LedgerRuntime<SchemaType, Classes>,
): Effect.Effect<LedgerCompletion, LedgerFailure> {
  return runtime.transition
    .withPermits(1)(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const phase = yield* restore(Ref.get(runtime.phase));
          const settled = Match.value(phase).pipe(
            Match.tag("completed", ({ completion }) =>
              Effect.succeed(completion),
            ),
            Match.tag("failed", ({ cause }) => Effect.failCause(cause)),
            Match.tag("open", () => undefined),
            Match.exhaustive,
          );
          if (settled !== undefined) {
            return yield* settled;
          }
          const recordCount = Chunk.size(
            yield* restore(Ref.get(runtime.history)),
          );
          const result = yield* Effect.exit(
            runtime.completeStored(recordCount),
          );
          if (Exit.isFailure(result)) {
            return yield* latchFailure(runtime, result.cause);
          }
          yield* Ref.set(runtime.phase, {
            _tag: "completed",
            completion: result.value,
          });
          yield* PubSub.publish(runtime.changes, undefined);
          return result.value;
        }),
      ),
    )
    .pipe(Effect.withSpan("RunLedger.complete"));
}

interface InitializedRunLedger<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
> {
  readonly allocation: LedgerAllocation;
  readonly runtime: LedgerRuntime<SchemaType, Classes>;
}

function initializeRunLedger<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  catalog: EventCatalog<SchemaType, Classes>,
  options: RunLedgerOptions,
): Effect.Effect<
  InitializedRunLedger<SchemaType, Classes>,
  LedgerStorageError,
  LedgerStorage | Scope.Scope
> {
  return Effect.gen(function* () {
    const storage = yield* LedgerStorage;
    const allocation = yield* storage.allocate({
      definitionId: options.definitionId,
      catalogTags: catalog.tags,
      provenance: options.provenance,
      metadata: options.metadata,
    });
    const startedAtNanos = yield* Clock.currentTimeNanos;
    const changes = yield* PubSub.sliding<undefined>(LEDGER_WAKEUP_CAPACITY);
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
    const history = yield* Ref.make(
      Chunk.empty<LedgerRecord<CatalogOf<SchemaType, Classes>>>(),
    );
    const phase = yield* Ref.make<LedgerPhase>({ _tag: "open" });
    const failure = yield* Deferred.make<never, LedgerFailure>();
    const transition = yield* Effect.makeSemaphore(1);
    return {
      allocation,
      runtime: {
        catalog,
        runId: allocation.runId,
        startedAtNanos,
        appendStored: allocation.append,
        completeStored: allocation.complete,
        changes,
        history,
        phase,
        failure,
        transition,
      },
    };
  });
}

function makeActiveLedger<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  runtime: LedgerRuntime<SchemaType, Classes>,
  ledger: RunLedger<CatalogOf<SchemaType, Classes>>,
): ActiveRunLedger<CatalogOf<SchemaType, Classes>> {
  return {
    ledger,
    failure: Deferred.await(runtime.failure),
    writerFor: (producer, subset) => {
      const accepted = isCatalogSubset(runtime.catalog, subset);
      return {
        write: (input) =>
          accepted
            ? writeRecord(runtime, subset, producer, input)
            : Effect.dieMessage(
                "Writer catalog is outside this ledger catalog",
              ),
      };
    },
    complete: () => completeLedger(runtime),
  };
}
