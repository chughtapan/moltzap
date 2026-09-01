# simulator/ledger

_`packages/simulator/src/ledger`_

## Purpose

Typed live and completed simulator ledgers.

## Public surface

### [`CompletedLedgerArtifacts`](./read.ts#L104)

_Interface_

```ts
export interface CompletedLedgerArtifacts {
  readonly manifest: string;
  readonly records: string;
  readonly completion: string;
}
```

Complete immutable artifact text retrieved from a profile-owned store.

### [`CompletedRunLedger`](./read.ts#L93)

_Interface_

```ts
export interface CompletedRunLedger<Catalog> {
  readonly ref: LedgerRef;
  readonly manifest: LedgerManifest;
  readonly completion: LedgerCompletion;
  readonly records: Stream.Stream<LedgerRecord<Catalog>>;
  readonly events: <Event extends EventClassOf<Catalog>>(
    eventClass: Event,
  ) => Stream.Stream<Schema.Schema.Type<Event>>;
}
```

Fully validated immutable ledger whose streams cannot fail.

### [`EncodedEventOf`](./../events/catalog.ts#L45)

_TypeAlias_

```ts
export type EncodedEventOf<Catalog> = Schema.Schema.Encoded<
  CatalogSchemaOf<Catalog>
>;
```

The closed encoded union persisted for a catalog.

### [`EventCatalog`](./../events/catalog.ts#L132)

_Class_

```ts
export class EventCatalog<
  SchemaType extends CatalogSchema,
  Classes extends EventClass = EventClass,
> {
  readonly schema: Schema.Schema<
    Schema.Schema.Type<SchemaType>,
    Schema.Schema.Encoded<SchemaType>
  >;
  readonly eventClasses: readonly EventClass[];
  readonly tags: readonly VersionedEventTag[];
  private readonly [eventCatalogTypeId] = eventCatalogTypeId;

  private constructor(schema: SchemaType, eventClasses: readonly EventClass[]) {
    this.schema = Schema.make<
      Schema.Schema.Type<SchemaType>,
      Schema.Schema.Encoded<SchemaType>
    >(schema.ast);
    this.eventClasses = Object.freeze([...eventClasses]);
    this.tags = Object.freeze(
      this.eventClasses.map((eventClass) => eventClass._tag),
    );
    Object.freeze(this);
  }

  static make<
    const EventClasses extends readonly [
      EventClass,
      ...(readonly EventClass[]),
    ],
  >(
    ...eventClasses: EventClasses
  ): EventCatalog<EventClassesSchema<EventClasses>, EventClasses[number]> {
    validateEventClasses(eventClasses);
    return new EventCatalog(makeEventClassesSchema(eventClasses), eventClasses);
  }

  static empty(): EventCatalog<Schema.Schema<never>, never> {
    const eventClasses: readonly never[] = [];
    return new EventCatalog(Schema.make<never>(Schema.Never.ast), eventClasses);
  }

  static merge<
    const Catalogs extends readonly [
      EventCatalog<CatalogSchema>,
      ...ReadonlyArray<EventCatalog<CatalogSchema>>,
    ],
  >(
    ...catalogs: Catalogs
  ): EventCatalog<
    MergedCatalogSchema<Catalogs>,
    CatalogClassesOf<Catalogs[number]>
  > {
    const eventClasses = catalogs.flatMap((catalog) => catalog.eventClasses);
    validateEventClasses(eventClasses);
    return new EventCatalog(mergeCatalogSchemas(catalogs), eventClasses);
  }

  has(eventClass: EventClass): eventClass is Classes {
    return this.eventClasses.some(
      (catalogEventClass) => catalogEventClass === eventClass,
    );
  }

  hasEvent(event: unknown): event is Schema.Schema.Type<SchemaType> {
    if (typeof event !== "object" || event === null) {
      return false;
    }
    const constructor: unknown = Reflect.get(event, "constructor");
    return this.eventClasses.some((eventClass) => eventClass === constructor);
  }

  decode(input: unknown) {
    return Schema.decodeUnknown(Schema.asSchema(this.schema))(input, {
      onExcessProperty: "error",
    });
  }

  encode(event: Schema.Schema.Type<SchemaType>) {
    return Schema.encode(Schema.asSchema(this.schema))(event, {
      onExcessProperty: "error",
    });
  }
}
```

The exact immutable event universe for one definition.

The private type identifier makes catalog arguments nominal: a structural
object cannot claim a schema, constructor list, and tag list that disagree.

### [`EventCatalogDefinitionError`](./../events/catalog.ts#L61)

_Class_

```ts
export class EventCatalogDefinitionError extends Schema.TaggedError<EventCatalogDefinitionError>()(
  "EventCatalogDefinitionError",
  {
    failure: Schema.Literal("duplicate-tag", "invalid-tag"),
    tag: Schema.String,
  },
) {
  override get message(): string {
    return definitionFailureMessage[this.failure](this.tag);
  }
}
```

Invalid catalogs fail during definition construction, before a run starts.

### [`EventCatalogDefinitionFailure`](./../events/catalog.ts#L50)

_TypeAlias_

```ts
export type EventCatalogDefinitionFailure = "duplicate-tag" | "invalid-tag";
```

Represents event catalog definition failure conditions.

### [`EventClass`](./../events/catalog.ts#L12)

_TypeAlias_

```ts
export type EventClass = Schema.Schema.AnyNoContext & {
  readonly _tag: VersionedEventTag;
};
```

A schema-backed event constructor. The catalog retains both the schema and
constructor faces so persisted values decode back into their exact class.

### [`EventClassOf`](./../events/catalog.ts#L42)

_TypeAlias_

```ts
export type EventClassOf<Catalog> = CatalogClassesOf<Catalog>;
```

The closed constructor union declared by a catalog.

### [`EventOf`](./../events/catalog.ts#L39)

_TypeAlias_

```ts
export type EventOf<Catalog> = Schema.Schema.Type<CatalogSchemaOf<Catalog>>;
```

The closed instance union declared by a catalog.

### [`JsonObject`](./schema.ts#L47)

_TypeAlias_

```ts
export type JsonObject = typeof jsonObjectSchema.Type;
```

Represents json object values.

### [`jsonValue`](./schema.ts#L31)

_Variable_

```ts
export const jsonValue: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(jsonValue),
    Schema.Record({ key: Schema.String, value: jsonValue }),
  ),
).annotations({ identifier: "LedgerJsonValue" })
```

Validates and decodes json value values.

### [`JsonValue`](./schema.ts#L21)

_TypeAlias_

```ts
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

Represents json value values.

### [`LEDGER_FORMAT_VERSION`](./schema.ts#L12)

_Variable_

```ts
export const LEDGER_FORMAT_VERSION = 1
```

Provides the ledger format version runtime value.

### [`LedgerAllocation`](./storage.ts#L73)

_Interface_

```ts
export interface LedgerAllocation {
  readonly ref: LedgerRef;
  readonly runId: string;
  readonly manifest: LedgerManifest;
  readonly append: (
    serializedRecord: string,
  ) => Effect.Effect<void, LedgerStorageError>;
  readonly complete: (
    recordCount: number,
  ) => Effect.Effect<LedgerCompletion, LedgerStorageError>;
}
```

One storage-owned live allocation.

### [`LedgerAllocationInput`](./storage.ts#L65)

_Interface_

```ts
export interface LedgerAllocationInput {
  readonly definitionId: string;
  readonly catalogTags: readonly VersionedEventTag[];
  readonly provenance: JsonObject;
  readonly metadata: JsonObject;
}
```

Describes ledger allocation input.

### [`LedgerArtifact`](./storage.ts#L20)

_TypeAlias_

```ts
export type LedgerArtifact = typeof ledgerArtifactSchema.Type;
```

Represents ledger artifact values.

### [`ledgerArtifactFiles`](./storage.ts#L30)

_Variable_

```ts
export const ledgerArtifactFiles =
```

The durable file name each ledger artifact is published under.

### [`LedgerCatalogMismatch`](./read.ts#L60)

_Class_

```ts
export class LedgerCatalogMismatch extends Schema.TaggedError<LedgerCatalogMismatch>()(
  "LedgerCatalogMismatch",
  {
    expectedTags: Schema.Array(versionedEventTag),
    actualTags: Schema.Array(versionedEventTag),
  },
) {
  override get message(): string {
    return `The ledger catalog does not match this simulator definition: expected [${this.expectedTags.join(", ")}], found [${this.actualTags.join(", ")}]`;
  }
}
```

Implements ledger catalog mismatch.

### [`LedgerCompletion`](./schema.ts#L77)

_Class_

```ts
export class LedgerCompletion extends Schema.Class<LedgerCompletion>(
  "LedgerCompletion",
)({
  ledgerFormatVersion: Schema.Literal(LEDGER_FORMAT_VERSION),
  runId: Schema.NonEmptyString,
  recordCount: nonNegativeInteger,
  artifacts: Schema.Struct({
    manifest: ledgerDigest,
    records: ledgerDigest,
  }),
}) {}
```

The immutable publication marker for a completed ledger.

### [`LedgerDefinitionMismatch`](./read.ts#L73)

_Class_

```ts
export class LedgerDefinitionMismatch extends Schema.TaggedError<LedgerDefinitionMismatch>()(
  "LedgerDefinitionMismatch",
  {
    expectedDefinitionId: versionedDefinitionId,
    actualDefinitionId: versionedDefinitionId,
  },
) {
  override get message(): string {
    return `The ledger belongs to definition "${this.actualDefinitionId}", not "${this.expectedDefinitionId}"`;
  }
}
```

Implements ledger definition mismatch.

### [`ledgerDigest`](./schema.ts#L56)

_Variable_

```ts
export const ledgerDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("LedgerDigest"),
)
```

Validates and decodes ledger digest values.

### [`LedgerDigest`](./schema.ts#L61)

_TypeAlias_

```ts
export type LedgerDigest = typeof ledgerDigest.Type;
```

Represents ledger digest values.

### [`LedgerFailure`](./append.ts#L59)

_TypeAlias_

```ts
export type LedgerFailure =
  | LedgerStorageError
  | ParseResult.ParseError
  | LedgerSerializationError;
```

Represents ledger failure conditions.

### [`LedgerInvalid`](./read.ts#L46)

_Class_

```ts
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
```

Implements ledger invalid.

### [`LedgerInvalidReason`](./read.ts#L43)

_TypeAlias_

```ts
export type LedgerInvalidReason = typeof ledgerInvalidReasonSchema.Type;
```

Represents ledger invalid reason values.

### [`LedgerManifest`](./schema.ts#L64)

_Class_

```ts
export class LedgerManifest extends Schema.Class<LedgerManifest>(
  "LedgerManifest",
)({
  ledgerFormatVersion: Schema.Literal(LEDGER_FORMAT_VERSION),
  definitionId: versionedDefinitionId,
  runId: Schema.NonEmptyString,
  catalogTags: Schema.Array(versionedEventTag),
  createdAt: Schema.DateTimeUtc,
  provenance: jsonObjectSchema,
  metadata: jsonObjectSchema,
}) {}
```

Definition and provenance bound to every completed ledger.

### [`LedgerOpenError`](./read.ts#L86)

_TypeAlias_

```ts
export type LedgerOpenError =
  | LedgerCatalogMismatch
  | LedgerDefinitionMismatch
  | LedgerInvalid
  | LedgerStorageError;
```

Represents ledger open error conditions.

### [`LedgerRecord`](./schema.ts#L90)

_Interface_

```ts
export interface LedgerRecord<Catalog> {
  readonly runId: string;
  readonly eventId: string;
  readonly logicalSequence: number;
  readonly elapsedNanos: bigint;
  readonly observedAt: number;
  readonly producer: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly event: EventOf<Catalog>;
}
```

One exact event envelope in a run ledger.

### [`ledgerRef`](./schema.ts#L15)

_Variable_

```ts
export const ledgerRef = Schema.NonEmptyString.pipe(Schema.brand("LedgerRef"))
```

Storage-owned identity that never exposes a filesystem path.

### [`LedgerRef`](./schema.ts#L17)

_TypeAlias_

```ts
export type LedgerRef = typeof ledgerRef.Type;
```

Represents ledger ref values.

### [`LedgerSerializationError`](./append.ts#L50)

_Class_

```ts
export class LedgerSerializationError extends Schema.TaggedError<LedgerSerializationError>()(
  "LedgerSerializationError",
  {
    operation: Schema.Literal("parse", "stringify"),
    cause: Schema.Defect,
  },
) {}
```

Reports ledger serialization failures.

### [`LedgerStorage`](./storage.ts#L129)

_Class_

```ts
export class LedgerStorage extends Context.Tag(
  "@moltzap/simulator/LedgerStorage",
)<LedgerStorage, LedgerStorageService>() {}
```

Outer layers provide the concrete ledger persistence implementation.

### [`LedgerStorageError`](./storage.ts#L49)

_Class_

```ts
export class LedgerStorageError extends Schema.TaggedError<LedgerStorageError>()(
  "LedgerStorageError",
  {
    operation: ledgerStorageOperationSchema,
    detail: Schema.String,
    ref: Schema.optional(ledgerRef),
    artifact: Schema.optional(ledgerArtifactSchema),
  },
) {
  override get message(): string {
    const subject = this.ref ?? "ledger storage";
    return `${this.operation} ${subject}: ${this.detail}`;
  }
}
```

Stable failure at the ledger storage boundary.

### [`LedgerStorageService`](./storage.ts#L99)

_Interface_

```ts
export interface LedgerStorageService {
  readonly allocate: (
    input: LedgerAllocationInput,
  ) => Effect.Effect<LedgerAllocation, LedgerStorageError>;
  readonly read: (
    ref: LedgerRef,
    artifact: LedgerArtifact,
  ) => Effect.Effect<string, LedgerStorageError>;
  readonly digest: (
    text: string,
  ) => Effect.Effect<LedgerDigest, LedgerStorageError>;
}
```

Describes ledger storage service.

### [`makeLedgerRecordSchema`](./schema.ts#L107)

_Function_

```ts
export function makeLedgerRecordSchema<
  SchemaType extends Schema.Schema.All,
  Classes extends EventClass,
>(catalog: EventCatalog<SchemaType, Classes>)
```

The envelope schema shared by live commits and completed-ledger inspection.

**Returns:** The created ledger record schema.

### [`openLedger`](./read.ts#L136)

_Function_

```ts
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
>
```

Validate a completed ledger before exposing its reusable typed record
stream. The exact catalog is required; no unknown-event branch escapes.

**Returns:** The open ledger result.

### [`openLedgerArtifacts`](./read.ts#L163)

_Function_

```ts
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
>
```

Validate already-retrieved durable artifacts without exposing their storage
backend through the customer program.

**Returns:** A validated completed ledger with infallible record streams.

### [`readLedgerManifest`](./read.ts#L114)

_Variable_

```ts
export const readLedgerManifest = Effect.fn("readLedgerManifest")(function* (
  ref: LedgerRef,
): Effect.fn.Return<
  LedgerManifest,
  LedgerInvalid | LedgerStorageError,
  LedgerStorage
> {
  const reader = ledgerReaderFor(yield* LedgerStorage, ref);
  const text = yield* reader.read("manifest");
  const manifest = yield* decodeJson("manifest", LedgerManifest, text);
  yield* validateManifestTags(manifest);
  return manifest;
})
```

Inspect definition and provenance without granting access to unverified
records.

### [`RunLedger`](./append.ts#L65)

_Interface_

```ts
export interface RunLedger<Catalog> {
  readonly ref: LedgerRef;
  readonly manifest: LedgerManifest;
  readonly records: Stream.Stream<LedgerRecord<Catalog>, LedgerFailure>;
  readonly events: <Event extends EventClassOf<Catalog>>(
    eventClass: Event,
  ) => Stream.Stream<Schema.Schema.Type<Event>, LedgerFailure>;
}
```

Readable, definition-bound live ledger capability.

### [`VersionedEventTag`](./../events/catalog.ts#L6)

_TypeAlias_

```ts
export type VersionedEventTag = `${string}.${string}/v${number}`;
```

Stable persisted identity for an event class.

## Files

- `append.ts`
- `filesystem.ts`
- `index.ts`
- `read.ts`
- `schema.ts`
- `storage.ts`
