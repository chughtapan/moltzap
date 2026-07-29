import { Context, Effect, Schema } from "effect";
import type { VersionedEventTag } from "../events/catalog.js";
import {
  LedgerRef,
  type JsonObject,
  type LedgerCompletion,
  type LedgerDigest,
  type LedgerManifest,
} from "./model.js";

const LedgerArtifactSchema = Schema.Literal(
  "manifest",
  "records",
  "completion",
);
export type LedgerArtifact = typeof LedgerArtifactSchema.Type;

const LedgerStorageOperationSchema = Schema.Literal(
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
    operation: LedgerStorageOperationSchema,
    detail: Schema.String,
    ref: Schema.optional(LedgerRef),
    artifact: Schema.optional(LedgerArtifactSchema),
  },
) {
  override get message(): string {
    const subject = this.ref === undefined ? "ledger storage" : this.ref;
    return `${this.operation} ${subject}: ${this.detail}`;
  }
}

export interface LedgerAllocationInput {
  readonly definitionId: string;
  readonly catalogTags: ReadonlyArray<VersionedEventTag>;
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
