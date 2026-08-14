/** @file Persisted simulator ledger identities, JSON values, manifests, completions, and records. */

import { Schema } from "effect";
import {
  type EventCatalog,
  type EventClass,
  type EventOf,
  versionedEventTag,
} from "../events/catalog.js";

/** Provides the ledger format version runtime value. */
export const LEDGER_FORMAT_VERSION = 1;

/** Storage-owned identity that never exposes a filesystem path. */
export const ledgerRef = Schema.NonEmptyString.pipe(Schema.brand("LedgerRef"));
/** Represents ledger ref values. */
export type LedgerRef = typeof ledgerRef.Type;

/* eslint-disable agent-code-guard/no-nullish-type-aliases -- JSON includes null as a first-class value by definition. */
/** Represents json value values. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
/* eslint-enable agent-code-guard/no-nullish-type-aliases -- The JSON-specific recursive union ends here. */

/** Validates and decodes json value values. */
export const jsonValue: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(jsonValue),
    Schema.Record({ key: Schema.String, value: jsonValue }),
  ),
).annotations({ identifier: "LedgerJsonValue" });

const jsonObjectSchema = Schema.Record({
  key: Schema.String,
  value: jsonValue,
});
/** Represents json object values. */
export type JsonObject = typeof jsonObjectSchema.Type;

/** The persisted spelling of a simulator definition's identity. */
export const versionedDefinitionId = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u),
);
const nonNegativeInteger = Schema.Int.pipe(Schema.nonNegative());

/** Validates and decodes ledger digest values. */
export const ledgerDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("LedgerDigest"),
);
/** Represents ledger digest values. */
export type LedgerDigest = typeof ledgerDigest.Type;

/** Definition and provenance bound to every completed ledger. */
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

/** The immutable publication marker for a completed ledger. */
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

/**
 * The envelope schema shared by live commits and completed-ledger inspection.
 * @param catalog Closed event catalog whose variants populate record envelopes.
 * @returns The created ledger record schema.
 */
export function makeLedgerRecordSchema<
  SchemaType extends Schema.Schema.All,
  Classes extends EventClass,
>(catalog: EventCatalog<SchemaType, Classes>) {
  return Schema.Struct({
    runId: Schema.NonEmptyString,
    eventId: Schema.NonEmptyString,
    logicalSequence: nonNegativeInteger,
    elapsedNanos: Schema.NonNegativeBigInt,
    observedAt: nonNegativeInteger,
    producer: Schema.NonEmptyString,
    causationId: Schema.optional(Schema.NonEmptyString),
    correlationId: Schema.optional(Schema.NonEmptyString),
    event: Schema.asSchema(catalog.schema),
  });
}
