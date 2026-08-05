import { createHash } from "node:crypto";
import { Effect, type ParseResult, Schema, Stream } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import type {
  EventCatalog,
  EventClass,
  EventClassOf,
  VersionedEventTag,
} from "../events/catalog.js";
import {
  LedgerCompletion,
  ledgerDigest,
  LedgerManifest,
  type LedgerRef,
  makeLedgerRecordSchema,
  type LedgerRecord,
} from "./schema.js";
import { ledgerEvents } from "./append.js";
import {
  LedgerStorage,
  LedgerStorageError,
  type LedgerArtifact,
  type LedgerStorageService,
} from "./storage.js";

const versionedEventTagSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u),
);
const versionedIdentifierSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u),
);

const ledgerInvalidReasonSchema = Schema.Literal(
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
/** Represents ledger invalid reason values. */
export type LedgerInvalidReason = typeof ledgerInvalidReasonSchema.Type;

/** Implements ledger invalid. */
export class LedgerInvalid extends Schema.TaggedError<LedgerInvalid>()(
  "LedgerInvalid",
  {
    artifact: Schema.Literal("manifest", "records", "completion"),
    reason: ledgerInvalidReasonSchema,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.artifact}: ${this.detail}`;
  }
}

/** Implements ledger catalog mismatch. */
export class LedgerCatalogMismatch extends Schema.TaggedError<LedgerCatalogMismatch>()(
  "LedgerCatalogMismatch",
  {
    expectedTags: Schema.Array(versionedEventTagSchema),
    actualTags: Schema.Array(versionedEventTagSchema),
  },
) {
  override get message(): string {
    return `The ledger catalog does not match this simulator definition: expected [${this.expectedTags.join(", ")}], found [${this.actualTags.join(", ")}]`;
  }
}

/** Implements ledger definition mismatch. */
export class LedgerDefinitionMismatch extends Schema.TaggedError<LedgerDefinitionMismatch>()(
  "LedgerDefinitionMismatch",
  {
    expectedDefinitionId: versionedIdentifierSchema,
    actualDefinitionId: versionedIdentifierSchema,
  },
) {
  override get message(): string {
    return `The ledger belongs to definition "${this.actualDefinitionId}", not "${this.expectedDefinitionId}"`;
  }
}

/** Represents ledger open error conditions. */
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

/** Complete immutable artifact text retrieved from a profile-owned store. */
export interface CompletedLedgerArtifacts {
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
  const decode: (
    input: unknown,
    options?: ParseOptions,
  ) => Effect.Effect<Schema.Schema.Type<S>, ParseResult.ParseError> =
    Schema.decodeUnknown(schema);
  return decode(input, strictDecode).pipe(
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
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validateManifestTags(
  manifest: LedgerManifest,
): Effect.Effect<void, LedgerInvalid> {
  const sorted = [...manifest.catalogTags].sort((left, right) =>
    left.localeCompare(right),
  );
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
  const expectedTags: readonly VersionedEventTag[] = [...catalog.tags].sort(
    (left, right) => left.localeCompare(right),
  );
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
  expectedDefinitionId?: string,
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
): Effect.Effect<readonly string[], LedgerInvalid> {
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
  expectedDefinitionId?: string,
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
 * @param catalog Value supplied to the operation.
 * @param ref Value supplied to the operation.
 * @param expectedDefinitionId Value supplied to the operation.
 * @returns The open ledger result.
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

function artifactStorage(
  ref: LedgerRef,
  artifacts: CompletedLedgerArtifacts,
): LedgerStorageService {
  return {
    allocate: () => Effect.dieMessage("completed artifacts are read-only"),
    read: (requestedRef, artifact) => {
      if (requestedRef !== ref) {
        return Effect.fail(
          LedgerStorageError.make({
            operation: "read",
            detail: "the retrieved artifacts belong to a different ledger",
            ref: requestedRef,
            artifact,
          }),
        );
      }
      return Effect.succeed(artifacts[artifact]);
    },
    digest: (text) =>
      Effect.try({
        try: () => createHash("sha256").update(text, "utf8").digest("hex"),
        catch: (cause) =>
          LedgerStorageError.make({
            operation: "digest",
            detail: String(cause),
          }),
      }).pipe(
        Effect.flatMap((digest) =>
          Schema.decodeUnknown(ledgerDigest)(digest).pipe(
            Effect.mapError((cause) =>
              LedgerStorageError.make({
                operation: "digest",
                detail: cause.message,
              }),
            ),
          ),
        ),
      ),
  };
}

/**
 * Validate already-retrieved durable artifacts without exposing their storage
 * backend through the customer program.
 * @param catalog Exact event catalog used to decode the records.
 * @param ref Durable ledger identity associated with the artifacts.
 * @param artifacts Complete artifact text retrieved from durable storage.
 * @param expectedDefinitionId Optional definition identity to verify.
 * @returns A validated completed ledger with infallible record streams.
 */
export function openLedgerArtifacts<
  SchemaType extends Schema.Schema.AnyNoContext,
  Classes extends EventClass,
>(
  catalog: EventCatalog<SchemaType, Classes>,
  ref: LedgerRef,
  artifacts: CompletedLedgerArtifacts,
  expectedDefinitionId?: string,
): Effect.Effect<
  CompletedRunLedger<EventCatalog<SchemaType, Classes>>,
  LedgerOpenError
> {
  const storage = artifactStorage(ref, artifacts);
  if (expectedDefinitionId === undefined) {
    return openLedger(catalog, ref).pipe(
      Effect.provideService(LedgerStorage, storage),
      Effect.withSpan("openLedgerArtifacts"),
    );
  }
  return openLedger(catalog, ref, expectedDefinitionId).pipe(
    Effect.provideService(LedgerStorage, storage),
    Effect.withSpan("openLedgerArtifacts"),
  );
}
