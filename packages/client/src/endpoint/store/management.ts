/** @file Recovery and frozen local management reads over certified history. */

import type { DatabaseSync } from "node:sqlite";
import type {
  CertifiedRecord,
  ConversationPage,
  EndpointRecovery,
  HistoryPage,
  StartIntent,
  StoredAnchor,
  StoredMembership,
} from "./types.js";
import {
  copyBytes,
  mintContinuation,
  readBytes,
  readInteger,
  readOptionalText,
  readText,
  StoreSignal,
  type StoreState,
  validateContinuation,
} from "./database/index.js";
import {
  readCertifiedRecord,
  readConversationPosition,
  readProtocolEvidence,
  readRecoveredReanchor,
  readStagedRecord,
  readStoredIdentity,
} from "./rows/index.js";

const HISTORY_PAGE_SIZE = 50;
const historyQuery = `
  SELECT staged.conversation_id, staged.record_hash,
         staged.previous_record_hash, staged.membership_hash,
         staged.anchor_hash, staged.canonical_record,
         certified.canonical_certified_record
  FROM certified_records AS certified
  JOIN staged_records AS staged
    ON staged.conversation_id = certified.conversation_id
   AND staged.record_hash = certified.record_hash
  WHERE certified.conversation_id = ? AND certified.ordinal > ?
  ORDER BY certified.ordinal
`;

/**
 * Lists locally certified conversation identifiers in canonical order.
 *
 * @param database Exclusively owned endpoint database.
 * @param input Optional exclusive canonical lower bound.
 * @returns At most fifty identifiers and whether more remain.
 */
export function searchStoredConversations(
  database: DatabaseSync,
  input: Readonly<{ afterConversationId?: string }>,
): ConversationPage {
  const rows = readConversationIdRows(database, input.afterConversationId);
  const conversationIds = rows
    .slice(0, HISTORY_PAGE_SIZE)
    .map((row) => readText(row, "conversation_id"));
  return Object.freeze({
    conversationIds: Object.freeze(conversationIds),
    hasMore: rows.length > HISTORY_PAGE_SIZE,
  });
}

/**
 * Reads or continues one process-local frozen certified-history snapshot.
 *
 * @param state Acquired database and process-local snapshots.
 * @param request New read anchor or opaque continuation.
 * @returns At most fifty complete contiguous records.
 */
export function readStoredConversation(
  state: StoreState,
  request:
    | Readonly<{ conversationId: string; afterRecordHash?: string }>
    | Readonly<{ continuation: string }>,
): HistoryPage {
  return "continuation" in request
    ? continueConversation(state, request.continuation)
    : beginConversationRead(state, request);
}

/**
 * Releases one live continuation without changing durable state.
 *
 * @param state Acquired database and process-local snapshots.
 * @param continuation Opaque process-local continuation to invalidate.
 */
export function releaseStoredContinuation(
  state: StoreState,
  continuation: string,
): void {
  validateContinuation(continuation);
  if (!state.snapshots.delete(continuation)) {
    throw new StoreSignal("invalid-continuation");
  }
}

/**
 * Recovers all durable endpoint state needed to resume protocol work.
 *
 * @param database Exclusively owned endpoint database.
 * @returns A detached snapshot of all durable endpoint protocol state.
 */
export function recoverStoredState(database: DatabaseSync): EndpointRecovery {
  const identity = readStoredIdentity(database);
  return Object.freeze({
    ...(identity === undefined ? {} : { identity }),
    startIntents: readStartIntents(database),
    memberships: readMemberships(database),
    anchors: readAnchors(database),
    positions: Object.freeze(
      database
        .prepare(
          `SELECT conversation_id, membership_hash, current_anchor_hash,
                  head_record_hash FROM conversation_state
           ORDER BY conversation_id`,
        )
        .all()
        .map(readConversationPosition),
    ),
    stagedRecords: Object.freeze(
      database
        .prepare(
          `SELECT conversation_id, record_hash, previous_record_hash,
                  membership_hash, anchor_hash, canonical_record
           FROM staged_records ORDER BY conversation_id, predecessor_key`,
        )
        .all()
        .map(readStagedRecord),
    ),
    evidence: readEvidence(database),
    certifiedRecords: readAllCertifiedRecords(database),
    stagedReanchors: readReanchors(database),
    consumedAttention: readConsumedAttention(database),
  });
}

function readConversationIdRows(
  database: DatabaseSync,
  afterConversationId?: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (afterConversationId === undefined) {
    return database
      .prepare(
        `SELECT conversation_id FROM conversation_state
         WHERE head_record_hash IS NOT NULL
         ORDER BY conversation_id COLLATE BINARY LIMIT 51`,
      )
      .all();
  }
  if (
    afterConversationId.length === 0 ||
    afterConversationId.includes("\u0000")
  ) {
    throw new StoreSignal("invalid-input");
  }
  return database
    .prepare(
      `SELECT conversation_id FROM conversation_state
       WHERE head_record_hash IS NOT NULL AND conversation_id > ?
       ORDER BY conversation_id COLLATE BINARY LIMIT 51`,
    )
    .all(afterConversationId);
}

function beginConversationRead(
  state: StoreState,
  request: Readonly<{
    conversationId: string;
    afterRecordHash?: string;
  }>,
): HistoryPage {
  const afterOrdinal = resolveAfterOrdinal(state.database, request);
  const rows = state.database
    .prepare(historyQuery)
    .all(request.conversationId, afterOrdinal);
  if (rows.length === 0 && afterOrdinal === -1) {
    throw new StoreSignal("not-found");
  }
  const records = Object.freeze(rows.map(readCertifiedRecord));
  return pageFromSnapshot(state, { records, offset: 0 });
}

function resolveAfterOrdinal(
  database: DatabaseSync,
  request: Readonly<{
    conversationId: string;
    afterRecordHash?: string;
  }>,
): number {
  if (request.conversationId.length === 0) {
    throw new StoreSignal("invalid-input");
  }
  if (request.afterRecordHash === undefined) {
    return -1;
  }
  const anchor = database
    .prepare(
      `SELECT ordinal FROM certified_records
       WHERE conversation_id = ? AND record_hash = ?`,
    )
    .get(request.conversationId, request.afterRecordHash);
  if (anchor === undefined) {
    throw new StoreSignal("not-found");
  }
  return readInteger(anchor, "ordinal");
}

function continueConversation(
  state: StoreState,
  continuation: string,
): HistoryPage {
  validateContinuation(continuation);
  const snapshot = state.snapshots.get(continuation);
  if (snapshot === undefined) {
    throw new StoreSignal("invalid-continuation");
  }
  state.snapshots.delete(continuation);
  return pageFromSnapshot(state, snapshot);
}

function pageFromSnapshot(
  state: StoreState,
  snapshot: Readonly<{
    records: readonly CertifiedRecord[];
    offset: number;
  }>,
): HistoryPage {
  const records = snapshot.records.slice(
    snapshot.offset,
    snapshot.offset + HISTORY_PAGE_SIZE,
  );
  const nextOffset = snapshot.offset + records.length;
  const continuation = retainNextPage(state, snapshot.records, nextOffset);
  return Object.freeze({
    records: Object.freeze(records.map(copyCertifiedRecord)),
    continuation,
  });
}

function retainNextPage(
  state: StoreState,
  records: readonly CertifiedRecord[],
  nextOffset: number,
): string | null {
  if (nextOffset >= records.length) {
    return null;
  }
  const continuation = mintContinuation(new Set(state.snapshots.keys()));
  state.snapshots.set(
    continuation,
    Object.freeze({ records, offset: nextOffset }),
  );
  return continuation;
}

function copyCertifiedRecord(record: CertifiedRecord): CertifiedRecord {
  return Object.freeze({
    ...record,
    canonicalRecord: copyBytes(record.canonicalRecord),
    canonicalCertifiedRecord: copyBytes(record.canonicalCertifiedRecord),
  });
}

function readStartIntents(database: DatabaseSync): readonly StartIntent[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT conversation_id, canonical_intent, completed_record_hash
         FROM start_intents ORDER BY conversation_id`,
      )
      .all()
      .map((row) => {
        const completedRecordHash = readOptionalText(
          row,
          "completed_record_hash",
        );
        return Object.freeze({
          conversationId: readText(row, "conversation_id"),
          canonicalIntent: readBytes(row, "canonical_intent"),
          ...(completedRecordHash === undefined ? {} : { completedRecordHash }),
        });
      }),
  );
}

function readMemberships(database: DatabaseSync): readonly StoredMembership[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT conversation_id, membership_hash, canonical_membership
         FROM memberships ORDER BY conversation_id`,
      )
      .all()
      .map((row) =>
        Object.freeze({
          conversationId: readText(row, "conversation_id"),
          membershipHash: readText(row, "membership_hash"),
          canonicalMembership: readBytes(row, "canonical_membership"),
        }),
      ),
  );
}

function readAnchors(database: DatabaseSync): readonly StoredAnchor[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT conversation_id, anchor_hash, previous_anchor_hash,
                selected_record_hash, canonical_anchor
         FROM anchors ORDER BY conversation_id, rowid`,
      )
      .all()
      .map((row) => {
        const previousAnchorHash = readOptionalText(
          row,
          "previous_anchor_hash",
        );
        const selectedRecordHash = readOptionalText(
          row,
          "selected_record_hash",
        );
        return Object.freeze({
          conversationId: readText(row, "conversation_id"),
          anchorHash: readText(row, "anchor_hash"),
          ...(previousAnchorHash === undefined ? {} : { previousAnchorHash }),
          ...(selectedRecordHash === undefined ? {} : { selectedRecordHash }),
          canonicalAnchor: readBytes(row, "canonical_anchor"),
        });
      }),
  );
}

function readEvidence(database: DatabaseSync) {
  return Object.freeze(
    database
      .prepare(
        `SELECT conversation_id, evidence_kind, subject_id,
                evidence_key, canonical_evidence
         FROM protocol_evidence
         ORDER BY conversation_id, evidence_kind, subject_id, evidence_key`,
      )
      .all()
      .map(readProtocolEvidence),
  );
}

function readAllCertifiedRecords(
  database: DatabaseSync,
): readonly CertifiedRecord[] {
  return Object.freeze(
    database
      .prepare(
        historyQuery
          .replace(
            "WHERE certified.conversation_id = ? AND certified.ordinal > ?",
            "",
          )
          .replace(
            "ORDER BY certified.ordinal",
            "ORDER BY certified.conversation_id, certified.ordinal",
          ),
      )
      .all()
      .map(readCertifiedRecord),
  );
}

function readReanchors(database: DatabaseSync) {
  return Object.freeze(
    database
      .prepare(
        `SELECT conversation_id, anchor_hash, previous_anchor_hash,
                router_instance_id, selected_record_hash, canonical_body,
                canonical_completed_reanchor
         FROM reanchors ORDER BY conversation_id, rowid`,
      )
      .all()
      .map(readRecoveredReanchor),
  );
}

function readConsumedAttention(database: DatabaseSync) {
  return Object.freeze(
    database
      .prepare(
        `SELECT conversation_id, record_hash FROM consumed_attention
         ORDER BY conversation_id, record_hash`,
      )
      .all()
      .map((row) =>
        Object.freeze({
          conversationId: readText(row, "conversation_id"),
          recordHash: readText(row, "record_hash"),
        }),
      ),
  );
}
