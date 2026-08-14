/** @file Typed live and completed simulator ledgers. */

/** Re-exports the public event catalog API. */
export {
  type EncodedEventOf,
  EventCatalog,
  EventCatalogDefinitionError,
  type EventCatalogDefinitionFailure,
  type EventClass,
  type EventClassOf,
  type EventOf,
  type VersionedEventTag,
} from "../events/catalog.js";
/** Re-exports the durable ledger model. */
export {
  type JsonObject,
  type JsonValue,
  jsonValue,
  LEDGER_FORMAT_VERSION,
  LedgerCompletion,
  type LedgerDigest,
  ledgerDigest,
  LedgerManifest,
  type LedgerRecord,
  type LedgerRef,
  ledgerRef,
  makeLedgerRecordSchema,
} from "./schema.js";
/** Re-exports the ledger storage port. */
export {
  type LedgerAllocation,
  type LedgerAllocationInput,
  type LedgerArtifact,
  ledgerArtifactFiles,
  LedgerStorage,
  LedgerStorageError,
  type LedgerStorageService,
} from "./storage.js";
/** Re-exports completed-ledger inspection. */
export {
  type CompletedLedgerArtifacts,
  type CompletedRunLedger,
  LedgerCatalogMismatch,
  LedgerDefinitionMismatch,
  LedgerInvalid,
  type LedgerInvalidReason,
  type LedgerOpenError,
  openLedger,
  openLedgerArtifacts,
  readLedgerManifest,
} from "./read.js";
/** Re-exports the live-ledger contract. */
export {
  type LedgerFailure,
  LedgerSerializationError,
  type RunLedger,
} from "./append.js";
