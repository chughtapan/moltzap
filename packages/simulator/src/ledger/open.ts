import { Effect, Schema, Stream } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import {
  EventCatalog,
  type EventClass,
  type EventClassOf,
  type VersionedEventTag,
} from "../events/catalog.js";
import {
  LedgerCompletion,
  LedgerManifest,
  LedgerRef,
  makeLedgerRecordSchema,
  type LedgerRecord,
} from "./model.js";
import { ledgerEvents } from "./live.js";
import {
  LedgerStorage,
  type LedgerArtifact,
  type LedgerStorageError,
} from "./storage.js";

const VersionedEventTagSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u),
);
const VersionedIdentifierSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u),
);

const LedgerInvalidReasonSchema = Schema.Literal(
  "catalog-tags-not-sorted",
  "digest-mismatch",
  "duplicate-event-id",
  "record-count-mismatch",
  "event-decode-failed",
  "invalid-json",
  "run-id-mismatch",
  "schema-mismatch",
  "sequence-mismatch",
);
export type LedgerInvalidReason = typeof LedgerInvalidReasonSchema.Type;

export class LedgerInvalid extends Schema.TaggedError<LedgerInvalid>()(
  "LedgerInvalid",
  {
    artifact: Schema.Literal("manifest", "records", "completion"),
    reason: LedgerInvalidReasonSchema,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.artifact}: ${this.detail}`;
  }
}

export class LedgerCatalogMismatch extends Schema.TaggedError<LedgerCatalogMismatch>()(
  "LedgerCatalogMismatch",
  {
    expectedTags: Schema.Array(VersionedEventTagSchema),
    actualTags: Schema.Array(VersionedEventTagSchema),
  },
) {
  override get message(): string {
    return `The ledger catalog does not match this simulator definition: expected [${this.expectedTags.join(", ")}], found [${this.actualTags.join(", ")}]`;
  }
}

export class LedgerDefinitionMismatch extends Schema.TaggedError<LedgerDefinitionMismatch>()(
  "LedgerDefinitionMismatch",
  {
    expectedDefinitionId: VersionedIdentifierSchema,
    actualDefinitionId: VersionedIdentifierSchema,
  },
) {
  override get message(): string {
    return `The ledger belongs to definition "${this.actualDefinitionId}", not "${this.expectedDefinitionId}"`;
  }
}

export type LedgerOpenError =
  | LedgerCatalogMismatch
  | LedgerDefinitionMismatch
  | LedgerInvalid
  | LedgerStorageError;

/** Fully validated immutable ledger whose streams cannot fail. */
export interface CompletedRunLedger<Catalog> {
  readonly ref: LedgerRef;
  readonly manifest: LedgerManifest;
  readonly completion: LedgerCompletion;
  readonly records: Stream.Stream<LedgerRecord<Catalog>>;
  readonly events: <Event extends EventClassOf<Catalog>>(
    eventClass: Event,
  ) => Stream.Stream<Schema.Schema.Type<Event>>;
}

interface LedgerArtifacts {
  readonly manifest: string;
  readonly records: string;
  readonly completion: string;
}

const strictDecode: ParseOptions = { onExcessProperty: "error" };

function invalid(
  artifact: LedgerArtifact,
  reason: LedgerInvalidReason,
  detail: string,
): LedgerInvalid {
  return LedgerInvalid.make({ artifact, reason, detail });
}

function parseJson(
  artifact: LedgerArtifact,
  text: string,
): Effect.Effect<unknown, LedgerInvalid> {
  return Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) => invalid(artifact, "invalid-json", String(cause)),
  });
}

function decodeSchema<S extends Schema.Schema.AnyNoContext>(
  artifact: LedgerArtifact,
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, LedgerInvalid> {
  return Schema.decodeUnknown(schema)(input, strictDecode).pipe(
    Effect.mapError((cause) =>
      invalid(artifact, "schema-mismatch", cause.message),
    ),
  );
}

function decodeJson<S extends Schema.Schema.AnyNoContext>(
  artifact: LedgerArtifact,
  schema: S,
  text: string,
): Effect.Effect<Schema.Schema.Type<S>, LedgerInvalid> {
  return parseJson(artifact, text).pipe(
    Effect.flatMap((input) => decodeSchema(artifact, schema, input)),
  );
}

function sameStrings(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validateManifestTags(
  manifest: LedgerManifest,
): Effect.Effect<void, LedgerInvalid> {
  const sorted = [...manifest.catalogTags].sort();
  return new Set(manifest.catalogTags).size === manifest.catalogTags.length &&
    sameStrings(sorted, manifest.catalogTags)
    ? Effect.void
    : Effect.fail(
        invalid(
          "manifest",
          "catalog-tags-not-sorted",
          "catalogTags must be unique and sorted",
        ),
      );
}

function verifyCatalog<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  catalog: EventCatalog<SchemaType, Classes>,
  manifest: LedgerManifest,
): Effect.Effect<void, LedgerCatalogMismatch> {
  const expectedTags: ReadonlyArray<VersionedEventTag> = [
    ...catalog.tags,
  ].sort();
  return sameStrings(expectedTags, manifest.catalogTags)
    ? Effect.void
    : Effect.fail(
        LedgerCatalogMismatch.make({
          expectedTags,
          actualTags: manifest.catalogTags,
        }),
      );
}

function verifyDefinition(
  manifest: LedgerManifest,
  expectedDefinitionId: string | undefined,
): Effect.Effect<void, LedgerDefinitionMismatch> {
  return expectedDefinitionId === undefined ||
    manifest.definitionId === expectedDefinitionId
    ? Effect.void
    : Effect.fail(
        LedgerDefinitionMismatch.make({
          expectedDefinitionId,
          actualDefinitionId: manifest.definitionId,
        }),
      );
}

function recordLines(
  text: string,
): Effect.Effect<ReadonlyArray<string>, LedgerInvalid> {
  if (text.length === 0) {
    return Effect.succeed([]);
  }
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  return body.length > 0 && lines.every((line) => line.length > 0)
    ? Effect.succeed(lines)
    : Effect.fail(
        invalid(
          "records",
          "invalid-json",
          "the ledger contains an empty record line",
        ),
      );
}

function decodeRecordLine<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  catalog: EventCatalog<SchemaType, Classes>,
  line: string,
): Effect.Effect<
  LedgerRecord<EventCatalog<SchemaType, Classes>>,
  LedgerInvalid
> {
  return parseJson("records", line).pipe(
    Effect.flatMap((input) =>
      Schema.decodeUnknown(makeLedgerRecordSchema(catalog))(
        input,
        strictDecode,
      ).pipe(
        Effect.mapError((cause) =>
          invalid("records", "event-decode-failed", cause.message),
        ),
      ),
    ),
  );
}

function validateRecords<Catalog>(
  runId: string,
  completion: LedgerCompletion,
  records: ReadonlyArray<LedgerRecord<Catalog>>,
): Effect.Effect<void, LedgerInvalid> {
  const eventIds = new Set<string>();
  for (const [expectedSequence, record] of records.entries()) {
    if (record.runId !== runId) {
      return Effect.fail(
        invalid(
          "records",
          "run-id-mismatch",
          `event ${record.eventId} belongs to a different run`,
        ),
      );
    }
    if (eventIds.has(record.eventId)) {
      return Effect.fail(
        invalid(
          "records",
          "duplicate-event-id",
          `eventId ${record.eventId} occurs more than once`,
        ),
      );
    }
    eventIds.add(record.eventId);
    if (record.logicalSequence !== expectedSequence) {
      return Effect.fail(
        invalid(
          "records",
          "sequence-mismatch",
          `expected sequence ${String(expectedSequence)}, found ${String(record.logicalSequence)}`,
        ),
      );
    }
  }
  return completion.recordCount === records.length
    ? Effect.void
    : Effect.fail(
        invalid(
          "completion",
          "record-count-mismatch",
          `completion claims ${String(completion.recordCount)} records, decoded ${String(records.length)}`,
        ),
      );
}

function verifyCompletion(
  manifest: LedgerManifest,
  completion: LedgerCompletion,
  manifestDigest: string,
  recordsDigest: string,
): Effect.Effect<void, LedgerInvalid> {
  if (completion.runId !== manifest.runId) {
    return Effect.fail(
      invalid(
        "completion",
        "run-id-mismatch",
        "completion runId differs from manifest",
      ),
    );
  }
  if (completion.artifacts.manifest !== manifestDigest) {
    return Effect.fail(
      invalid(
        "completion",
        "digest-mismatch",
        "manifest digest differs from the completion",
      ),
    );
  }
  return completion.artifacts.records === recordsDigest
    ? Effect.void
    : Effect.fail(
        invalid(
          "completion",
          "digest-mismatch",
          "records digest differs from the completion",
        ),
      );
}

/**
 * Inspect definition and provenance without granting access to unverified
 * records.
 */
export const readLedgerManifest = Effect.fn("readLedgerManifest")(function* (
  ref: LedgerRef,
): Effect.fn.Return<
  LedgerManifest,
  LedgerInvalid | LedgerStorageError,
  LedgerStorage
> {
  const storage = yield* LedgerStorage;
  const text = yield* storage.read(ref, "manifest");
  const manifest = yield* decodeJson("manifest", LedgerManifest, text);
  yield* validateManifestTags(manifest);
  return manifest;
});

function readLedgerArtifacts(
  ref: LedgerRef,
): Effect.Effect<LedgerArtifacts, LedgerStorageError, LedgerStorage> {
  return Effect.gen(function* () {
    const storage = yield* LedgerStorage;
    return yield* Effect.all(
      {
        manifest: storage.read(ref, "manifest"),
        records: storage.read(ref, "records"),
        completion: storage.read(ref, "completion"),
      },
      { concurrency: 3 },
    );
  });
}

function decodeLedgerHeader<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  catalog: EventCatalog<SchemaType, Classes>,
  files: LedgerArtifacts,
  expectedDefinitionId: string | undefined,
) {
  return Effect.gen(function* () {
    const manifest = yield* decodeJson(
      "manifest",
      LedgerManifest,
      files.manifest,
    );
    yield* validateManifestTags(manifest);
    yield* verifyDefinition(manifest, expectedDefinitionId);
    yield* verifyCatalog(catalog, manifest);
    const completion = yield* decodeJson(
      "completion",
      LedgerCompletion,
      files.completion,
    );
    return { manifest, completion };
  });
}

function verifyLedgerDigests(
  files: LedgerArtifacts,
  manifest: LedgerManifest,
  completion: LedgerCompletion,
): Effect.Effect<void, LedgerInvalid | LedgerStorageError, LedgerStorage> {
  return Effect.gen(function* () {
    const storage = yield* LedgerStorage;
    const digests = yield* Effect.all(
      {
        manifest: storage.digest(files.manifest),
        records: storage.digest(files.records),
      },
      { concurrency: 2 },
    );
    yield* verifyCompletion(
      manifest,
      completion,
      digests.manifest,
      digests.records,
    );
  });
}

function decodeLedgerRecords<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(catalog: EventCatalog<SchemaType, Classes>, text: string) {
  return recordLines(text).pipe(
    Effect.flatMap((lines) =>
      Effect.forEach(lines, (line) => decodeRecordLine(catalog, line), {
        concurrency: 1,
      }),
    ),
  );
}

/**
 * Validate a completed ledger before exposing its reusable typed record
 * stream. The exact catalog is required; no unknown-event branch escapes.
 */
export function openLedger<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  catalog: EventCatalog<SchemaType, Classes>,
  ref: LedgerRef,
  expectedDefinitionId?: string,
): Effect.Effect<
  CompletedRunLedger<EventCatalog<SchemaType, Classes>>,
  LedgerOpenError,
  LedgerStorage
> {
  return Effect.gen(function* () {
    const files = yield* readLedgerArtifacts(ref);
    const { completion, manifest } = yield* decodeLedgerHeader(
      catalog,
      files,
      expectedDefinitionId,
    );
    yield* verifyLedgerDigests(files, manifest, completion);
    const records = yield* decodeLedgerRecords(catalog, files.records);
    yield* validateRecords(manifest.runId, completion, records);
    const snapshot = Object.freeze([...records]);
    const recordStream = Stream.fromIterable(snapshot);
    const completed: CompletedRunLedger<EventCatalog<SchemaType, Classes>> = {
      ref,
      manifest,
      completion,
      records: recordStream,
      events: (eventClass) => ledgerEvents(catalog, recordStream, eventClass),
    };
    return Object.freeze(completed);
  }).pipe(Effect.withSpan("openLedger"));
}
