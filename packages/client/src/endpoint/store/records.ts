/** @file Atomic record, evidence, head, and consumed-attention transitions. */

import type { DatabaseSync } from "node:sqlite";
import type {
  CertifiedRecord,
  ProtocolEvidence,
  StagedRecord,
  StoreMutation,
} from "./types.js";
import {
  copyBytes,
  readBytes,
  readOptionalText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  StoreSignal,
  transaction,
} from "./database/index.js";
import {
  findStagedReanchor,
  findStagedRecord,
  readStoredPosition,
  requireSameRecord,
} from "./rows/index.js";

const GENESIS_PREDECESSOR = "";

/**
 * Durably stages an exact verified action-certified record.
 *
 * @param database Exclusively owned endpoint database.
 * @param record Verified action-certified record and private bindings.
 * @returns Whether the same staged record was inserted or already durable.
 */
export function stageRecord(
  database: DatabaseSync,
  record: StagedRecord,
): StoreMutation {
  validateStagedRecord(record);
  return transaction(database, () =>
    stageRecordInTransaction(database, record),
  );
}

/**
 * Merges one stable evidence item without replacing a conflicting value.
 *
 * @param database Exclusively owned endpoint database.
 * @param evidence Verified evidence with its canonical merge key.
 * @returns Whether the evidence was inserted or already durable.
 */
export function mergeEvidence(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): StoreMutation {
  validateEvidence(evidence);
  return transaction(database, () =>
    mergeEvidenceInTransaction(database, evidence),
  );
}

/**
 * Atomically promotes a staged complete record and advances its local head.
 *
 * @param database Exclusively owned endpoint database.
 * @param record Verified complete certified record.
 * @returns Whether promotion advanced the head or was idempotent.
 */
export function promoteRecord(
  database: DatabaseSync,
  record: CertifiedRecord,
): StoreMutation {
  validateCertifiedRecord(record);
  return transaction(database, () =>
    promoteRecordInTransaction(database, record),
  );
}

/**
 * Atomically stages and promotes exactly one verified catch-up record item.
 *
 * @param database Exclusively owned endpoint database.
 * @param record One verified complete catch-up record.
 * @returns Whether any durable state was added.
 */
export function applyCatchUpRecord(
  database: DatabaseSync,
  record: CertifiedRecord,
): StoreMutation {
  validateCertifiedRecord(record);
  return transaction(database, () => {
    const staged = stageRecordInTransaction(database, record);
    const promoted = promoteRecordInTransaction(database, record);
    return staged === "inserted" || promoted === "inserted"
      ? "inserted"
      : "existing";
  });
}

/**
 * Durably consumes one complete certified record's runtime-attention slot.
 *
 * @param database Exclusively owned endpoint database.
 * @param input Complete certified record identity.
 * @returns Whether the consumed pair was inserted or already durable.
 */
export function consumeAttention(
  database: DatabaseSync,
  input: Readonly<{ conversationId: string; recordHash: string }>,
): StoreMutation {
  requireText(input.conversationId);
  requireText(input.recordHash);
  return transaction(database, () => {
    if (!hasCertifiedRecord(database, input.conversationId, input.recordHash)) {
      throw new StoreSignal("not-found");
    }
    if (hasConsumedAttention(database, input)) {
      return "existing";
    }
    database
      .prepare(
        `INSERT INTO consumed_attention
          (conversation_id, record_hash) VALUES (?, ?)`,
      )
      .run(input.conversationId, input.recordHash);
    return "inserted";
  });
}

/**
 * Reads whether one certified position's attention was already consumed.
 *
 * @param database Exclusively owned endpoint database.
 * @param input Conversation and complete record identity.
 * @returns True only when the durable consumed pair exists.
 */
export function hasConsumedAttention(
  database: DatabaseSync,
  input: Readonly<{ conversationId: string; recordHash: string }>,
): boolean {
  requireText(input.conversationId);
  requireText(input.recordHash);
  return (
    database
      .prepare(
        `SELECT 1 AS retained FROM consumed_attention
         WHERE conversation_id = ? AND record_hash = ?`,
      )
      .get(input.conversationId, input.recordHash) !== undefined
  );
}

function stageRecordInTransaction(
  database: DatabaseSync,
  record: StagedRecord,
): StoreMutation {
  const existing = findStagedRecord(
    database,
    record.conversationId,
    record.recordHash,
  );
  if (existing !== undefined) {
    requireSameRecord(existing, record);
    return "existing";
  }
  requireRecordPosition(database, record);
  requireUnclaimedPredecessor(database, record);
  insertStagedRecord(database, record);
  return "inserted";
}

function mergeEvidenceInTransaction(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): StoreMutation {
  requireEvidenceSubject(database, evidence);
  const existing = findEvidence(database, evidence);
  if (existing !== undefined) {
    requireSameBytes(existing, evidence.canonicalEvidence);
    return "existing";
  }
  database
    .prepare(
      `INSERT INTO protocol_evidence
        (conversation_id, evidence_kind, subject_id,
         evidence_key, canonical_evidence)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      evidence.conversationId,
      evidence.kind,
      evidence.subjectId,
      evidence.evidenceKey,
      copyBytes(evidence.canonicalEvidence),
    );
  return "inserted";
}

function promoteRecordInTransaction(
  database: DatabaseSync,
  record: CertifiedRecord,
): StoreMutation {
  const staged = findStagedRecord(
    database,
    record.conversationId,
    record.recordHash,
  );
  if (staged === undefined) {
    throw new StoreSignal("not-found");
  }
  requireSameRecord(staged, record);
  if (hasCertifiedRecord(database, record.conversationId, record.recordHash)) {
    return "existing";
  }
  const position = readStoredPosition(database, record.conversationId);
  requireEqual(position.currentAnchorHash, record.anchorHash);
  requireEqual(position.headRecordHash, record.previousRecordHash);
  insertCertifiedRecord(database, record, position.headOrdinal + 1);
  if (record.previousRecordHash === undefined) {
    completeStartIntent(database, record.conversationId, record.recordHash);
  }
  return "inserted";
}

function requireRecordPosition(
  database: DatabaseSync,
  record: StagedRecord,
): void {
  const position = readStoredPosition(database, record.conversationId);
  requireEqual(position.membershipHash, record.membershipHash);
  requireEqual(position.currentAnchorHash, record.anchorHash);
  requireEqual(position.headRecordHash, record.previousRecordHash);
}

function requireUnclaimedPredecessor(
  database: DatabaseSync,
  record: StagedRecord,
): void {
  const predecessorKey = record.previousRecordHash ?? GENESIS_PREDECESSOR;
  const conflicting = database
    .prepare(
      `SELECT record_hash FROM staged_records
       WHERE conversation_id = ? AND predecessor_key = ?`,
    )
    .get(record.conversationId, predecessorKey);
  if (conflicting !== undefined) {
    throw new StoreSignal("conflict");
  }
}

function insertStagedRecord(
  database: DatabaseSync,
  record: StagedRecord,
): void {
  database
    .prepare(
      `INSERT INTO staged_records
        (conversation_id, record_hash, predecessor_key, previous_record_hash,
         membership_hash, anchor_hash, canonical_record)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.conversationId,
      record.recordHash,
      record.previousRecordHash ?? GENESIS_PREDECESSOR,
      record.previousRecordHash ?? null,
      record.membershipHash,
      record.anchorHash,
      copyBytes(record.canonicalRecord),
    );
}

function findEvidence(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): Uint8Array | undefined {
  const row = database
    .prepare(
      `SELECT canonical_evidence FROM protocol_evidence
       WHERE conversation_id = ? AND evidence_kind = ?
         AND subject_id = ? AND evidence_key = ?`,
    )
    .get(
      evidence.conversationId,
      evidence.kind,
      evidence.subjectId,
      evidence.evidenceKey,
    );
  return row === undefined ? undefined : readBytes(row, "canonical_evidence");
}

function requireEvidenceSubject(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): void {
  requireMembership(database, evidence.conversationId);
  if (
    evidence.kind === "durability" &&
    findStagedRecord(database, evidence.conversationId, evidence.subjectId) ===
      undefined
  ) {
    throw new StoreSignal("not-found");
  }
  if (
    evidence.kind === "reanchor" &&
    findStagedReanchor(
      database,
      evidence.conversationId,
      evidence.subjectId,
    ) === undefined
  ) {
    throw new StoreSignal("not-found");
  }
}

function insertCertifiedRecord(
  database: DatabaseSync,
  record: CertifiedRecord,
  ordinal: number,
): void {
  database
    .prepare(
      `INSERT INTO certified_records
        (conversation_id, record_hash, ordinal, canonical_certified_record)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      record.conversationId,
      record.recordHash,
      ordinal,
      copyBytes(record.canonicalCertifiedRecord),
    );
  database
    .prepare(
      `UPDATE conversation_state
       SET head_record_hash = ?, head_ordinal = ? WHERE conversation_id = ?`,
    )
    .run(record.recordHash, ordinal, record.conversationId);
}

function completeStartIntent(
  database: DatabaseSync,
  conversationId: string,
  recordHash: string,
): void {
  const row = database
    .prepare(
      `SELECT completed_record_hash FROM start_intents
       WHERE conversation_id = ?`,
    )
    .get(conversationId);
  if (row === undefined) {
    throw new StoreSignal("not-found");
  }
  const completed = readOptionalText(row, "completed_record_hash");
  if (completed !== undefined && completed !== recordHash) {
    throw new StoreSignal("conflict");
  }
  database
    .prepare(
      `UPDATE start_intents SET completed_record_hash = ?
       WHERE conversation_id = ?`,
    )
    .run(recordHash, conversationId);
}

function requireMembership(
  database: DatabaseSync,
  conversationId: string,
): void {
  if (
    database
      .prepare(
        "SELECT 1 AS retained FROM memberships WHERE conversation_id = ?",
      )
      .get(conversationId) === undefined
  ) {
    throw new StoreSignal("not-found");
  }
}

function hasCertifiedRecord(
  database: DatabaseSync,
  conversationId: string,
  recordHash: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS retained FROM certified_records
         WHERE conversation_id = ? AND record_hash = ?`,
      )
      .get(conversationId, recordHash) !== undefined
  );
}

function validateCertifiedRecord(record: CertifiedRecord): void {
  validateStagedRecord(record);
  requireBytes(record.canonicalCertifiedRecord);
}

function validateStagedRecord(record: StagedRecord): void {
  requireText(record.conversationId);
  requireText(record.recordHash);
  if (record.previousRecordHash !== undefined) {
    requireText(record.previousRecordHash);
  }
  requireText(record.membershipHash);
  requireText(record.anchorHash);
  requireBytes(record.canonicalRecord);
}

function validateEvidence(evidence: ProtocolEvidence): void {
  requireText(evidence.conversationId);
  requireText(evidence.subjectId);
  requireText(evidence.evidenceKey);
  requireBytes(evidence.canonicalEvidence);
}
