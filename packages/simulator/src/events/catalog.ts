/** @file Closed schema-backed event catalogs with validated stable versioned tags. */

import { Schema } from "effect";

/** Stable persisted identity for an event class. */
export type VersionedEventTag = `${string}.${string}/v${number}`;

/**
 * A schema-backed event constructor. The catalog retains both the schema and
 * constructor faces so persisted values decode back into their exact class.
 */
export type EventClass = Schema.Schema.AnyNoContext & {
  readonly _tag: VersionedEventTag;
};

type CatalogSchema = Schema.Schema.All;

type EventClassesSchema<EventClasses extends readonly EventClass[]> =
  Schema.Schema<
    Schema.Schema.Type<EventClasses[number]>,
    Schema.Schema.Encoded<EventClasses[number]>
  >;

type CatalogParameters<Catalog> =
  Catalog extends EventCatalog<infer SchemaType, infer Classes>
    ? readonly [SchemaType, Classes]
    : never;
type CatalogSchemaOf<Catalog> = CatalogParameters<Catalog>[0];
type CatalogClassesOf<Catalog> = CatalogParameters<Catalog>[1];

type MergedCatalogSchema<
  Catalogs extends ReadonlyArray<EventCatalog<CatalogSchema>>,
> = Schema.Schema<
  Schema.Schema.Type<CatalogSchemaOf<Catalogs[number]>>,
  Schema.Schema.Encoded<CatalogSchemaOf<Catalogs[number]>>
>;

/** The closed instance union declared by a catalog. */
export type EventOf<Catalog> = Schema.Schema.Type<CatalogSchemaOf<Catalog>>;

/** The closed constructor union declared by a catalog. */
export type EventClassOf<Catalog> = CatalogClassesOf<Catalog>;

/** The closed encoded union persisted for a catalog. */
export type EncodedEventOf<Catalog> = Schema.Schema.Encoded<
  CatalogSchemaOf<Catalog>
>;

/** Represents event catalog definition failure conditions. */
export type EventCatalogDefinitionFailure = "duplicate-tag" | "invalid-tag";

const definitionFailureMessage: Readonly<
  Record<EventCatalogDefinitionFailure, (tag: string) => string>
> = {
  "duplicate-tag": (tag) => `Duplicate event tag "${tag}"`,
  "invalid-tag": (tag) =>
    `Event tag "${tag}" must be namespaced and versioned, for example "acme.consensus-reached/v1"`,
};

/** Invalid catalogs fail during definition construction, before a run starts. */
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

/**
 * The persisted spelling of an event tag. The tag type states that a namespace
 * and a version are present; this states what it cannot: lowercase segments
 * and a positive version, so `Acme.Foo/v1` and `acme.foo/v0` are rejected.
 */
export const versionedEventTag = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u),
);

const isVersionedEventTag = Schema.is(versionedEventTag);

const eventCatalogTypeId = Symbol.for("@moltzap/simulator/events/EventCatalog");

function validateEventClasses(eventClasses: readonly EventClass[]): void {
  const seen = new Set<string>();
  for (const eventClass of eventClasses) {
    const tag: string = eventClass._tag;
    if (!isVersionedEventTag(tag)) {
      throw EventCatalogDefinitionError.make({
        failure: "invalid-tag",
        tag,
      });
    }
    if (seen.has(tag)) {
      throw EventCatalogDefinitionError.make({
        failure: "duplicate-tag",
        tag,
      });
    }
    seen.add(tag);
  }
}

function makeEventClassesSchema<EventClasses extends readonly EventClass[]>(
  eventClasses: EventClasses,
): EventClassesSchema<EventClasses> {
  const union = Schema.Union(...eventClasses);
  return Schema.make<
    Schema.Schema.Type<EventClasses[number]>,
    Schema.Schema.Encoded<EventClasses[number]>
  >(union.ast);
}

function mergeCatalogSchemas<
  Catalogs extends ReadonlyArray<EventCatalog<CatalogSchema>>,
>(catalogs: Catalogs): MergedCatalogSchema<Catalogs> {
  const union = Schema.Union(...catalogs.map((catalog) => catalog.schema));
  return Schema.make<
    Schema.Schema.Type<CatalogSchemaOf<Catalogs[number]>>,
    Schema.Schema.Encoded<CatalogSchemaOf<Catalogs[number]>>
  >(union.ast);
}

/**
 * The exact immutable event universe for one definition.
 *
 * The private type identifier makes catalog arguments nominal: a structural
 * object cannot claim a schema, constructor list, and tag list that disagree.
 */
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
