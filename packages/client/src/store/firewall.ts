/** @file Private admission queues, evidence ranges and retained check attempts. */

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
import { putInboxItem } from "./inbox.js";
import {
  DeliveryToken,
  type FirewallAttempt,
  type FirewallAuditEntry,
  type FirewallCommit,
  type FirewallCompletion,
  type FirewallEvidence,
  type FirewallHistoryEntry,
  type FirewallInboxEntry,
  type InboxEntry,
  MAXIMUM_RUNTIME_ITEM_BYTES,
} from "./types.js";

// safer-arch-ignore file-implicit-boundary-module: Store composition and intent admission share these private transaction primitives so the audit, inbox, and intent writes commit atomically; only store/index.ts exposes the store capability.

const historySelect = `
  SELECT c.rowid AS position, s.canonical_record_core, m.canonical_membership,
    CASE WHEN i.delivery_token IS NOT NULL
      THEN 1 ELSE 0 END AS visible
  FROM certified_records c
  JOIN staged_records s ON s.conversation_id = c.conversation_id AND s.record_hash = c.record_hash
  JOIN memberships m ON m.conversation_id = c.conversation_id
  LEFT JOIN pending_deliveries d ON d.conversation_id = c.conversation_id AND d.record_hash = c.record_hash
  LEFT JOIN runtime_inbox i ON i.delivery_token = d.delivery_token
`;

const auditDisposition = Schema.Literal(
  "checking",
  "interrupted",
  "stale",
  "admitted",
  "withheld",
  "observed",
);

/** Shutdown readers page over every attempt while daemon writers are stopped. */
export function readFirewallAuditPage(
  database: DatabaseSync,
  after: number,
): readonly FirewallAuditEntry[] {
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new StoreSignal("invalid-input");
  }
  return database
    .prepare(`
    SELECT rowid AS sequence, check_id, direction, revision,
      canonical_candidate, canonical_input, canonical_result, disposition
    FROM firewall_checks WHERE rowid > ? ORDER BY rowid LIMIT 32
  `)
    .all(after)
    .map(auditEntry);
}

/** Previously visible items retain their admission; a held item is never requeued. */
export function queueFirewallItem(
  database: DatabaseSync,
  item: Omit<FirewallInboxEntry, "sequence">,
): void {
  requireText(item.conversation);
  requireBytes(item.canonicalItem);
  const visible = database
    .prepare(
      "SELECT canonical_item FROM runtime_inbox WHERE delivery_token = ?",
    )
    .get(item.deliveryToken);
  if (visible !== undefined) {
    requireSameBytes(readBytes(visible, "canonical_item"), item.canonicalItem);
    return;
  }
  const prior = database
    .prepare(
      "SELECT conversation, canonical_item FROM firewall_incoming WHERE delivery_token = ?",
    )
    .get(item.deliveryToken);
  if (prior !== undefined) {
    requireSameBytes(readBytes(prior, "canonical_item"), item.canonicalItem);
    if (readText(prior, "conversation") !== item.conversation) {
      throw new StoreSignal("conflict");
    }
    return;
  }
  database
    .prepare(
      "INSERT INTO firewall_incoming (delivery_token, conversation, canonical_item) VALUES (?, ?, ?)",
    )
    .run(item.deliveryToken, item.conversation, item.canonicalItem);
}

/** One unsettled predecessor per conversation is eligible for checking. */
export function readFirewallFrontiers(
  database: DatabaseSync,
): readonly FirewallInboxEntry[] {
  return database
    .prepare(`
    SELECT item.sequence, item.delivery_token, item.conversation, item.canonical_item
    FROM firewall_incoming item
    WHERE item.disposition = 'pending' AND NOT EXISTS (
      SELECT 1 FROM firewall_incoming earlier
      WHERE earlier.conversation = item.conversation
        AND earlier.disposition = 'pending' AND earlier.sequence < item.sequence
    ) ORDER BY item.sequence LIMIT 32
  `)
    .all()
    .map((row) => ({
      sequence: readInteger(row, "sequence"),
      deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
        readText(row, "delivery_token"),
      ),
      conversation: readText(row, "conversation"),
      canonicalItem: readBytes(row, "canonical_item"),
    }));
}

/** Restart recovery visits every private item, including successors behind a held frontier. */
export function readPendingFirewallItems(
  database: DatabaseSync,
  after: number,
): readonly FirewallInboxEntry[] {
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new StoreSignal("invalid-input");
  }
  return database
    .prepare(`
      SELECT sequence, delivery_token, conversation, canonical_item
      FROM firewall_incoming
      WHERE disposition = 'pending' AND sequence > ?
      ORDER BY sequence LIMIT 32
    `)
    .all(after)
    .map((row) => ({
      sequence: readInteger(row, "sequence"),
      deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
        readText(row, "delivery_token"),
      ),
      conversation: readText(row, "conversation"),
      canonicalItem: readBytes(row, "canonical_item"),
    }));
}

/** Incoming evidence stops strictly before the candidate's local certification position. */
export function readFirewallEvidence(
  database: DatabaseSync,
  input: {
    readonly beforeDelivery?: DeliveryToken;
    readonly maximumRecords: number;
  },
): FirewallEvidence {
  if (
    !Number.isSafeInteger(input.maximumRecords) ||
    input.maximumRecords < 1 ||
    input.maximumRecords > 1024
  ) {
    throw new StoreSignal("invalid-input");
  }
  const candidate =
    input.beforeDelivery === undefined
      ? undefined
      : database
          .prepare(`${historySelect} WHERE d.delivery_token = ?`)
          .get(input.beforeDelivery);
  const history = boundedHistory(
    database,
    input.maximumRecords,
    candidate === undefined
      ? Number.MAX_SAFE_INTEGER
      : readInteger(candidate, "position"),
  );
  return {
    revision: firewallRevision(database),
    ...history,
    pendingOutgoing:
      database
        .prepare(
          "SELECT 1 AS pending FROM post_intents WHERE completed_record_hash IS NULL LIMIT 1",
        )
        .get() !== undefined,
    ...(candidate === undefined ? {} : { candidate: historyEntry(candidate) }),
  };
}

/** A started attempt survives interruption without being mistaken for a decision. */
export function beginFirewallAttempt(
  database: DatabaseSync,
  attempt: FirewallAttempt,
): void {
  requireText(attempt.checkId);
  requireBytes(attempt.canonicalCandidate);
  requireBytes(attempt.canonicalInput);
  database
    .prepare(`
    INSERT INTO firewall_checks (check_id, direction, revision, canonical_candidate, canonical_input)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(
      attempt.checkId,
      attempt.direction,
      attempt.revision,
      attempt.canonicalCandidate,
      attempt.canonicalInput,
    );
}

/** Unsupported application forms retain refusal or shadow evidence without authorizing an intent. */
export function finishFirewallAttempt(
  database: DatabaseSync,
  completion: FirewallCompletion,
): void {
  completeFirewallCheck(
    database,
    completion,
    completion.admit ? "observed" : "withheld",
  );
}

/** Visibility, guidance and audit commit together; a hold also retires raw delivery work. */
export function admitFirewallItem(
  database: DatabaseSync,
  item: Omit<InboxEntry, "sequence">,
  completion: FirewallCompletion,
): FirewallCommit {
  return transaction(database, () => {
    requireQueueFrontier(database, item);
    const disposition = compareFirewallCheck(
      database,
      completion,
      "incoming",
      item.canonicalItem,
    );
    if (disposition === "stale") {
      return disposition;
    }
    if (disposition === "admitted") {
      putInboxItem(database, item);
    } else {
      database
        .prepare(
          "UPDATE pending_deliveries SET acknowledged = 1 WHERE delivery_token = ?",
        )
        .run(item.deliveryToken);
    }
    database
      .prepare(
        "UPDATE firewall_incoming SET disposition = ? WHERE delivery_token = ?",
      )
      .run(disposition, item.deliveryToken);
    return disposition;
  });
}
/** A fresh result and its exact candidate are compared inside the caller's transaction. */
export function compareFirewallCheck(
  database: DatabaseSync,
  completion: FirewallCompletion,
  direction: FirewallAttempt["direction"],
  canonicalCandidate: Uint8Array,
): FirewallCommit {
  const row = database
    .prepare(
      "SELECT direction, revision, canonical_candidate, disposition FROM firewall_checks WHERE check_id = ?",
    )
    .get(completion.checkId);
  if (
    row === undefined ||
    readText(row, "disposition") !== "checking" ||
    readText(row, "direction") !== direction
  ) {
    throw new StoreSignal("conflict");
  }
  requireSameBytes(readBytes(row, "canonical_candidate"), canonicalCandidate);
  const fresh =
    completion.shadow === true ||
    readInteger(row, "revision") === firewallRevision(database);
  const disposition = completion.admit
    ? admittedDisposition(fresh)
    : "withheld";
  completeFirewallCheck(database, completion, disposition);
  return disposition;
}

function auditEntry(
  row: Readonly<Record<string, unknown>>,
): FirewallAuditEntry {
  const canonicalResult = readOptionalBytes(row, "canonical_result");
  return {
    sequence: readInteger(row, "sequence"),
    checkId: readText(row, "check_id"),
    direction: Schema.decodeUnknownSync(Schema.Literal("incoming", "outgoing"))(
      readText(row, "direction"),
    ),
    revision: readInteger(row, "revision"),
    canonicalCandidate: readBytes(row, "canonical_candidate"),
    canonicalInput: readBytes(row, "canonical_input"),
    disposition: Schema.decodeUnknownSync(auditDisposition)(
      readText(row, "disposition"),
    ),
    ...(canonicalResult === undefined ? {} : { canonicalResult }),
  };
}

function admittedDisposition(fresh: boolean): "admitted" | "stale" {
  return fresh ? "admitted" : "stale";
}

function completeFirewallCheck(
  database: DatabaseSync,
  completion: FirewallCompletion,
  disposition: FirewallCommit | "observed",
): void {
  requireBytes(completion.canonicalResult);
  const changed = database
    .prepare(`
    UPDATE firewall_checks SET canonical_result = ?, disposition = ?
    WHERE check_id = ? AND disposition = 'checking'
  `)
    .run(completion.canonicalResult, disposition, completion.checkId);
  if (changed.changes !== 1) {
    throw new StoreSignal("conflict");
  }
}

/** Whole records are kept or omitted; a byte bound becomes an explicit evidence gap. */
function boundedHistory(
  database: DatabaseSync,
  maximumRecords: number,
  before: number,
) {
  const rows = database
    .prepare(`${historySelect} WHERE c.rowid < ? ORDER BY c.rowid LIMIT ?`)
    .iterate(before, maximumRecords + 1);
  const history: FirewallHistoryEntry[] = [];
  let bytes = 0;
  for (const row of rows) {
    const entry = historyEntry(row);
    bytes +=
      entry.canonicalRecordCore.byteLength +
      entry.canonicalMembership.byteLength;
    if (
      history.length === maximumRecords ||
      bytes > MAXIMUM_RUNTIME_ITEM_BYTES
    ) {
      return { history, overflow: true };
    }
    history.push(entry);
  }
  return { history, overflow: false };
}

function historyEntry(
  row: Readonly<Record<string, unknown>>,
): FirewallHistoryEntry {
  return {
    canonicalRecordCore: readBytes(row, "canonical_record_core"),
    canonicalMembership: readBytes(row, "canonical_membership"),
    visible: readInteger(row, "visible") === 1,
  };
}

/** Revisions cover range membership and visibility, including known absences. */
function firewallRevision(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT revision FROM firewall_evidence WHERE singleton = 1")
    .get();
  if (row === undefined) {
    throw new StoreSignal("corrupt");
  }
  return readInteger(row, "revision");
}

function requireQueueFrontier(
  database: DatabaseSync,
  item: Omit<InboxEntry, "sequence">,
): void {
  const queued = database
    .prepare(`
      SELECT conversation, sequence, canonical_item FROM firewall_incoming
      WHERE delivery_token = ? AND disposition = 'pending'
    `)
    .get(item.deliveryToken);
  if (queued === undefined) {
    throw new StoreSignal("conflict");
  }
  requireSameBytes(readBytes(queued, "canonical_item"), item.canonicalItem);
  const predecessor = database
    .prepare(`
      SELECT 1 AS pending FROM firewall_incoming
      WHERE conversation = ? AND sequence < ? AND disposition = 'pending' LIMIT 1
    `)
    .get(readText(queued, "conversation"), readInteger(queued, "sequence"));
  if (predecessor !== undefined) {
    throw new StoreSignal("conflict");
  }
}
