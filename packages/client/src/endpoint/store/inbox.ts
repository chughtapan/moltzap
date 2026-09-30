/** @file Durable host projection, invocation identity and event transport state. */

import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
  readBytes,
  readInteger,
  readOptionalBytes,
  readText,
  requireBytes,
  requireSameBytes,
  requireText,
  StoreSignal,
  transaction,
} from "./database/index.js";
import {
  DeliveryToken,
  type InboxEntry,
  type InboxPage,
  type InboxSummary,
  type StoredSendAttempt,
  type StoreMutation,
} from "./types.js";

const MAXIMUM_PAGE_ITEMS = 50;
const MAXIMUM_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * Bind a delivery token to exactly one classified payload, including after ack.
 * @param database Exclusively owned endpoint database.
 * @param item Immutable classified delivery.
 * @returns Whether this call inserted the binding.
 */
export function putInboxItem(
  database: DatabaseSync,
  item: Omit<InboxEntry, "sequence">,
): StoreMutation {
  requireBytes(item.canonicalItem);
  if (item.canonicalItem.byteLength > MAXIMUM_PAGE_BYTES) {
    throw new StoreSignal("invalid-input");
  }
  const retained = database
    .prepare(
      "SELECT canonical_item FROM runtime_inbox WHERE delivery_token = ?",
    )
    .get(item.deliveryToken);
  if (retained !== undefined) {
    requireSameBytes(readBytes(retained, "canonical_item"), item.canonicalItem);
    return "existing";
  }
  database
    .prepare(
      "INSERT INTO runtime_inbox (delivery_token, canonical_item) VALUES (?, ?)",
    )
    .run(item.deliveryToken, item.canonicalItem);
  return "inserted";
}

const requireSequence = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreSignal("invalid-continuation");
  }
  return value;
};

const newestSequence = (database: DatabaseSync): number => {
  const row = database
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS newest FROM runtime_inbox")
    .get();
  if (row === undefined) {
    throw new StoreSignal("corrupt");
  }
  return readInteger(row, "newest");
};

interface InboxBounds {
  readonly after?: number;
  readonly through?: number;
  readonly limit?: number;
}

const pageLimit = (
  input: InboxBounds,
  after: number,
  through: number,
): number => {
  const limit = input.limit ?? MAXIMUM_PAGE_ITEMS;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAXIMUM_PAGE_ITEMS ||
    after > through
  ) {
    throw new StoreSignal("invalid-continuation");
  }
  return limit;
};

const collectPage = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  limit: number,
): readonly InboxEntry[] => {
  const items: InboxEntry[] = [];
  let bytes = 0;
  for (const row of rows) {
    const canonicalItem = readBytes(row, "canonical_item");
    if (
      items.length === limit ||
      (items.length > 0 &&
        bytes + canonicalItem.byteLength > MAXIMUM_PAGE_BYTES)
    ) {
      break;
    }
    items.push({
      sequence: readInteger(row, "sequence"),
      deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
        readText(row, "delivery_token"),
      ),
      canonicalItem,
    });
    bytes += canonicalItem.byteLength;
  }
  return items;
};

/**
 * Read an inbox page without allowing concurrent arrivals to extend its snapshot.
 * @param database Exclusively owned endpoint database.
 * @param input Sequence bounds and maximum item count.
 * @returns Pending items and an optional next position within the same snapshot.
 */
export function readInbox(
  database: DatabaseSync,
  input: InboxBounds = {},
): InboxPage {
  const after = requireSequence(input.after ?? 0);
  const through = requireSequence(input.through ?? newestSequence(database));
  const limit = pageLimit(input, after, through);
  const rows = database
    .prepare(
      "SELECT sequence, delivery_token, canonical_item FROM runtime_inbox WHERE acknowledged = 0 AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?",
    )
    .all(after, through, limit + 1);
  const items = collectPage(rows, limit);
  const last = items.at(-1);
  return {
    items,
    through,
    ...(last !== undefined && rows.length > items.length
      ? { nextAfter: last.sequence }
      : {}),
  };
}

/**
 * Read counters for notification coalescing without disclosing inbox contents.
 * @param database Exclusively owned endpoint database.
 * @returns Current unread count and monotonic insertion position.
 */
export function readInboxSummary(database: DatabaseSync): InboxSummary {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS pending FROM runtime_inbox WHERE acknowledged = 0",
    )
    .get();
  if (row === undefined) {
    throw new StoreSignal("corrupt");
  }
  return {
    pendingCount: readInteger(row, "pending"),
    newestSequence: newestSequence(database),
  };
}

const retireItem = (
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
): void => {
  const retained = database
    .prepare(
      "SELECT delivery_token FROM runtime_inbox WHERE delivery_token = ?",
    )
    .get(deliveryToken);
  if (retained === undefined) {
    throw new StoreSignal("not-found");
  }
  database
    .prepare(
      "UPDATE runtime_inbox SET acknowledged = 1 WHERE delivery_token = ?",
    )
    .run(deliveryToken);
  database
    .prepare(
      "UPDATE pending_deliveries SET acknowledged = 1 WHERE delivery_token = ?",
    )
    .run(deliveryToken);
};

/**
 * Retire the host projection and any underlying pending protocol row atomically.
 * @param database Exclusively owned endpoint database.
 * @param deliveryToken Stable delivered identity, including an existing tombstone.
 */
export function acknowledgeInboxItem(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
): void {
  transaction(database, () => {
    retireItem(database, deliveryToken);
  });
}

/**
 * Replace an unavailable request with a newly identified failure without a gap.
 * @param database Exclusively owned endpoint database.
 * @param deliveryToken Original request's delivery identity.
 * @param replacement Failure under a distinct delivery identity.
 */
export function replaceInboxItem(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
  replacement: Omit<InboxEntry, "sequence">,
): void {
  if (deliveryToken === replacement.deliveryToken) {
    throw new StoreSignal("conflict");
  }
  transaction(database, () => {
    const projected = database
      .prepare(
        "SELECT delivery_token FROM runtime_inbox WHERE delivery_token = ?",
      )
      .get(deliveryToken);
    if (projected === undefined) {
      const retired = database
        .prepare(
          "UPDATE pending_deliveries SET acknowledged = 1 WHERE delivery_token = ? AND acknowledged = 0",
        )
        .run(deliveryToken);
      if (retired.changes !== 1) {
        throw new StoreSignal("not-found");
      }
    } else {
      retireItem(database, deliveryToken);
    }
    putInboxItem(database, replacement);
  });
}

/**
 * Reserve an invocation before any protocol side effect can occur.
 * @param database Exclusively owned endpoint database.
 * @param key Caller-selected invocation identity.
 * @param canonicalInput Exact validated input and failure-routing policy.
 * @returns Whether this invocation is new or already retained.
 */
export function beginSendAttempt(
  database: DatabaseSync,
  key: string,
  canonicalInput: Uint8Array,
): StoreMutation {
  requireText(key);
  requireBytes(canonicalInput);
  const retained = readSendAttempt(database, key);
  if (retained !== undefined) {
    requireSameBytes(retained.canonicalInput, canonicalInput);
    return "existing";
  }
  database
    .prepare(
      "INSERT INTO runtime_sends (invocation_key, canonical_input) VALUES (?, ?)",
    )
    .run(key, canonicalInput);
  return "inserted";
}

/**
 * Retain the invocation's observed tool outcome without inferring certification.
 * @param database Exclusively owned endpoint database.
 * @param key Previously reserved invocation identity.
 * @param canonicalOutcome Exact success or typed failure returned by the send.
 */
export function finishSendAttempt(
  database: DatabaseSync,
  key: string,
  canonicalOutcome: Uint8Array,
): void {
  requireBytes(canonicalOutcome);
  const retained = readSendAttempt(database, key);
  if (retained === undefined) {
    throw new StoreSignal("not-found");
  }
  if (retained.canonicalOutcome !== undefined) {
    requireSameBytes(retained.canonicalOutcome, canonicalOutcome);
    return;
  }
  database
    .prepare(
      "UPDATE runtime_sends SET canonical_outcome = ? WHERE invocation_key = ?",
    )
    .run(canonicalOutcome, key);
}

/**
 * Read retained invocation evidence; no outcome means execution is uncertain.
 * @param database Exclusively owned endpoint database.
 * @param key Caller-selected invocation identity.
 * @returns The exact reservation and its outcome when one was retained.
 */
export function readSendAttempt(
  database: DatabaseSync,
  key: string,
): StoredSendAttempt | undefined {
  requireText(key);
  const row = database
    .prepare(
      "SELECT canonical_input, canonical_outcome FROM runtime_sends WHERE invocation_key = ?",
    )
    .get(key);
  if (row === undefined) {
    return undefined;
  }
  const outcome = readOptionalBytes(row, "canonical_outcome");
  return {
    canonicalInput: readBytes(row, "canonical_input"),
    ...(outcome === undefined ? {} : { canonicalOutcome: outcome }),
  };
}

/**
 * Read the runtime-owned event state without interpreting its private format.
 * @param database Exclusively owned endpoint database.
 * @returns Persisted registration and callback delivery state, when present.
 */
export function readEventState(database: DatabaseSync): Uint8Array | undefined {
  const row = database
    .prepare("SELECT canonical_state FROM runtime_events WHERE singleton = 1")
    .get();
  return row === undefined ? undefined : readBytes(row, "canonical_state");
}

/**
 * Atomically replace the one runtime consumer's durable event state.
 * @param database Exclusively owned endpoint database.
 * @param canonicalState Runtime-validated registration and delivery state.
 */
export function writeEventState(
  database: DatabaseSync,
  canonicalState: Uint8Array,
): void {
  requireBytes(canonicalState);
  database
    .prepare(
      "INSERT INTO runtime_events (singleton, canonical_state) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET canonical_state = excluded.canonical_state",
    )
    .run(canonicalState);
}
