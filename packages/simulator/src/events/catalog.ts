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

type EventClassesSchema<EventClasses extends ReadonlyArray<EventClass>> =
  Schema.Schema<
    Schema.Schema.Type<EventClasses[number]>,
    Schema.Schema.Encoded<EventClasses[number]>,
    never
  >;

type CatalogSchemaOf<Catalog> =
  Catalog extends EventCatalog<infer SchemaType, infer _Classes>
    ? SchemaType
    : never;

type CatalogClassesOf<Catalog> =
  Catalog extends EventCatalog<infer _SchemaType, infer Classes>
    ? Classes
    : never;

type MergedCatalogSchema<
  Catalogs extends ReadonlyArray<EventCatalog<CatalogSchema, EventClass>>,
> = Schema.Schema<
  Schema.Schema.Type<CatalogSchemaOf<Catalogs[number]>>,
  Schema.Schema.Encoded<CatalogSchemaOf<Catalogs[number]>>,
  never
>;

/** The closed instance union declared by a catalog. */
export type EventOf<Catalog> = Schema.Schema.Type<CatalogSchemaOf<Catalog>>;

/** The closed constructor union declared by a catalog. */
export type EventClassOf<Catalog> = CatalogClassesOf<Catalog>;

/** The closed encoded union persisted for a catalog. */
export type EncodedEventOf<Catalog> = Schema.Schema.Encoded<
  CatalogSchemaOf<Catalog>
>;

export type EventCatalogDefinitionFailure =
  | "duplicate-tag"
  | "invalid-event-class"
  | "invalid-tag";

/** Invalid catalogs fail during definition construction, before a run starts. */
export class EventCatalogDefinitionError extends Schema.TaggedError<EventCatalogDefinitionError>()(
  "EventCatalogDefinitionError",
  {
    failure: Schema.Literal(
      "duplicate-tag",
      "invalid-event-class",
      "invalid-tag",
    ),
    tag: Schema.String,
  },
) {
  override get message(): string {
    switch (this.failure) {
      case "duplicate-tag":
        return `Duplicate event tag "${this.tag}"`;
      case "invalid-event-class":
        return `Event catalog member "${this.tag}" is not a schema-backed class`;
      case "invalid-tag":
        return `Event tag "${this.tag}" must be namespaced and versioned, for example "acme.consensus-reached/v1"`;
    }
  }
}

const VERSIONED_EVENT_TAG =
  /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u;

const EventCatalogTypeId = Symbol.for("@moltzap/simulator/events/EventCatalog");

function eventClassTag(eventClass: EventClass): string {
  if (typeof eventClass !== "function") {
    return String(eventClass);
  }
  const tag: unknown = Reflect.get(eventClass, "_tag");
  return typeof tag === "string" ? tag : String(tag);
}

function isEventClass(eventClass: EventClass): boolean {
  return (
    typeof eventClass === "function" &&
    Schema.isSchema(eventClass) &&
    typeof Reflect.get(eventClass, "_tag") === "string"
  );
}

function validateEventClasses(eventClasses: ReadonlyArray<EventClass>): void {
  const seen = new Set<string>();
  for (const eventClass of eventClasses) {
    const tag = eventClassTag(eventClass);
    if (!isEventClass(eventClass)) {
      throw EventCatalogDefinitionError.make({
        failure: "invalid-event-class",
        tag,
      });
    }
    if (!VERSIONED_EVENT_TAG.test(tag)) {
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

function makeEventClassesSchema<EventClasses extends ReadonlyArray<EventClass>>(
  eventClasses: EventClasses,
): EventClassesSchema<EventClasses> {
  const union = Schema.Union(...eventClasses);
  return Schema.make<
    Schema.Schema.Type<EventClasses[number]>,
    Schema.Schema.Encoded<EventClasses[number]>,
    never
  >(union.ast);
}

function mergeCatalogSchemas<
  Catalogs extends ReadonlyArray<EventCatalog<CatalogSchema, EventClass>>,
>(catalogs: Catalogs): MergedCatalogSchema<Catalogs> {
  const union = Schema.Union(...catalogs.map((catalog) => catalog.schema));
  return Schema.make<
    Schema.Schema.Type<CatalogSchemaOf<Catalogs[number]>>,
    Schema.Schema.Encoded<CatalogSchemaOf<Catalogs[number]>>,
    never
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
    Schema.Schema.Encoded<SchemaType>,
    never
  >;
  readonly eventClasses: ReadonlyArray<EventClass>;
  readonly tags: ReadonlyArray<VersionedEventTag>;
  private readonly [EventCatalogTypeId] = EventCatalogTypeId;

  private constructor(
    schema: SchemaType,
    eventClasses: ReadonlyArray<EventClass>,
  ) {
    this.schema = Schema.make<
      Schema.Schema.Type<SchemaType>,
      Schema.Schema.Encoded<SchemaType>,
      never
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
      ...ReadonlyArray<EventClass>,
    ],
  >(
    ...eventClasses: EventClasses
  ): EventCatalog<EventClassesSchema<EventClasses>, EventClasses[number]> {
    validateEventClasses(eventClasses);
    return new EventCatalog(makeEventClassesSchema(eventClasses), eventClasses);
  }

  static empty(): EventCatalog<Schema.Schema<never>, never> {
    const eventClasses: ReadonlyArray<never> = [];
    return new EventCatalog(Schema.make<never>(Schema.Never.ast), eventClasses);
  }

  static merge<
    const Catalogs extends readonly [
      EventCatalog<CatalogSchema, EventClass>,
      ...ReadonlyArray<EventCatalog<CatalogSchema, EventClass>>,
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
