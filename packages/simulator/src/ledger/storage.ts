import { Context, type Effect, Schema } from "effect";
import type { VersionedEventTag } from "../events/catalog.js";
import {
  type LedgerRef,
  ledgerRef,
  type JsonObject,
  type LedgerCompletion,
  type LedgerDigest,
  type LedgerManifest,
} from "./model.js";

const ledgerArtifactSchema = Schema.Literal(
  "manifest",
  "records",
  "completion",
);
/** Represents ledger artifact values. */
export type LedgerArtifact = typeof ledgerArtifactSchema.Type;

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

/** Outer layers provide the concrete ledger persistence implementation. */
export class LedgerStorage extends Context.Tag(
  "@moltzap/simulator/LedgerStorage",
)<LedgerStorage, LedgerStorageService>() {}
