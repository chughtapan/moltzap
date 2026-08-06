import { Context, type Effect, Schema } from "effect";
import type { VersionedEventTag } from "../events/catalog.js";
import {
  type LedgerRef,
  ledgerRef,
  type JsonObject,
  type LedgerCompletion,
  type LedgerDigest,
  type LedgerManifest,
} from "./schema.js";

const ledgerArtifactSchema = Schema.Literal(
  "manifest",
  "records",
  "completion",
);
/** Represents ledger artifact values. */
export type LedgerArtifact = typeof ledgerArtifactSchema.Type;

/**
 * The three bound artifacts in publication order. Completion is last because
 * it is the marker that binds the digests of the two artifacts before it.
 */
export const ledgerArtifacts: readonly LedgerArtifact[] =
  ledgerArtifactSchema.literals;

/** The durable file name each ledger artifact is published under. */
export const ledgerArtifactFiles = {
  manifest: "manifest.json",
  records: "records.ndjson",
  completion: "completion.json",
} as const satisfies Readonly<Record<LedgerArtifact, string>>;

/** One durable ledger artifact file name. */
export type LedgerArtifactFile =
  (typeof ledgerArtifactFiles)[keyof typeof ledgerArtifactFiles];

const ledgerStorageOperationSchema = Schema.Literal(
  "allocate",
  "append",
  "complete",
  "read",
  "digest",
);

/** Stable failure at the ledger storage boundary. */
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

/** Describes ledger allocation input. */
export interface LedgerAllocationInput {
  readonly definitionId: string;
  readonly catalogTags: readonly VersionedEventTag[];
  readonly provenance: JsonObject;
  readonly metadata: JsonObject;
}

/** One storage-owned live allocation. */
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

/**
 * Read access to the durable artifacts of exactly one ledger. A reader carries
 * its own reference, so nothing it returns can come from a second ledger.
 */
export interface LedgerReader {
  readonly read: (
    artifact: LedgerArtifact,
  ) => Effect.Effect<string, LedgerStorageError>;
  readonly digest: (
    text: string,
  ) => Effect.Effect<LedgerDigest, LedgerStorageError>;
}

/** Describes ledger storage service. */
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

/**
 * Bind one stored ledger for reading.
 * @param storage Allocating storage that holds many ledgers.
 * @param ref Ledger whose artifacts the reader exposes.
 * @returns Read-only access to that one ledger.
 */
export function ledgerReaderFor(
  storage: LedgerStorageService,
  ref: LedgerRef,
): LedgerReader {
  return {
    read: (artifact) => storage.read(ref, artifact),
    digest: storage.digest,
  };
}

/** Outer layers provide the concrete ledger persistence implementation. */
export class LedgerStorage extends Context.Tag(
  "@moltzap/simulator/LedgerStorage",
)<LedgerStorage, LedgerStorageService>() {}
