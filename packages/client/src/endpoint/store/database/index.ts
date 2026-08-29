/** @file Stable internal boundary for SQLite state and closed value checks. */

/** SQLite ownership, transaction, and lifecycle primitives. */
export {
  closeStoreState,
  type HistorySnapshot,
  openStoreState,
  runStoreOperation,
  type StoreState,
  transaction,
} from "./schema.js";
/** Closed failures and exact canonical-value helpers. */
export {
  copyBytes,
  EndpointStoreError,
  type EndpointStoreFailure,
  mapStoreFailure,
  mintContinuation,
  mintDeliveryToken,
  readBytes,
  readInteger,
  readOptionalBytes,
  readOptionalText,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  StoreSignal,
  validateContinuation,
} from "./values.js";
