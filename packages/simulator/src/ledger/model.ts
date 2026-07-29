import { Schema } from "effect";
import {
  EventCatalog,
  type EventClass,
  type EventOf,
} from "../events/catalog.js";

export const LEDGER_FORMAT_VERSION = 1;

/** Storage-owned identity that never exposes a filesystem path. */
export const LedgerRef = Schema.NonEmptyString.pipe(Schema.brand("LedgerRef"));
export type LedgerRef = typeof LedgerRef.Type;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

export const JsonValue: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(JsonValue),
    Schema.Record({ key: Schema.String, value: JsonValue }),
  ),
).annotations({ identifier: "LedgerJsonValue" });

const JsonObjectSchema = Schema.Record({
  key: Schema.String,
  value: JsonValue,
});
export type JsonObject = typeof JsonObjectSchema.Type;

const VersionedIdentifierSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u),
);
const VersionedEventTagSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u),
);
const NonNegativeInteger = Schema.Int.pipe(Schema.nonNegative());

export const LedgerDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("LedgerDigest"),
);
export type LedgerDigest = typeof LedgerDigest.Type;

/** Definition and provenance bound to every completed ledger. */
export class LedgerManifest extends Schema.Class<LedgerManifest>(
  "LedgerManifest",
)({
  ledgerFormatVersion: Schema.Literal(LEDGER_FORMAT_VERSION),
  definitionId: VersionedIdentifierSchema,
  runId: Schema.NonEmptyString,
  catalogTags: Schema.Array(VersionedEventTagSchema),
  createdAt: Schema.DateTimeUtc,
  provenance: JsonObjectSchema,
  metadata: JsonObjectSchema,
}) {}

/** The immutable publication marker for a completed ledger. */
export class LedgerCompletion extends Schema.Class<LedgerCompletion>(
  "LedgerCompletion",
)({
  ledgerFormatVersion: Schema.Literal(LEDGER_FORMAT_VERSION),
  runId: Schema.NonEmptyString,
  recordCount: NonNegativeInteger,
  artifacts: Schema.Struct({
    manifest: LedgerDigest,
    records: LedgerDigest,
  }),
}) {}

/** One exact event envelope in a run ledger. */
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

/** The envelope schema shared by live commits and completed-ledger inspection. */
export function makeLedgerRecordSchema<
  SchemaType extends Schema.Schema.All,
  Classes extends EventClass,
>(catalog: EventCatalog<SchemaType, Classes>) {
  return Schema.Struct({
    runId: Schema.NonEmptyString,
    eventId: Schema.NonEmptyString,
    logicalSequence: NonNegativeInteger,
    elapsedNanos: Schema.NonNegativeBigInt,
    observedAt: NonNegativeInteger,
    producer: Schema.NonEmptyString,
    causationId: Schema.optional(Schema.NonEmptyString),
    correlationId: Schema.optional(Schema.NonEmptyString),
    event: Schema.asSchema(catalog.schema),
  });
}
