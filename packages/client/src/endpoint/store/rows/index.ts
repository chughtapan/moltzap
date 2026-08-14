/** @file Typed projections and exact-binding checks for endpoint-store rows. */

import type { DatabaseSync } from "node:sqlite";
import type {
  CertifiedRecord,
  ConversationPosition,
  IdentityBinding,
  ProtocolEvidence,
  RecoveredReanchor,
  StagedReanchor,
  StagedRecord,
} from "../types.js";
import {
  readBytes,
  readInteger,
  readOptionalBytes,
  readOptionalText,
  readText,
  requireEqual,
  requireSameBytes,
  StoreSignal,
} from "../database/index.js";

/** Durable position plus the local indexing aid that carries no authority. */
export interface InternalPosition extends ConversationPosition {
  readonly headOrdinal: number;
}

/**
 * Projects one complete certified record.
 *
 * @param row SQLite result row.
 * @returns The detached complete certified record.
 */
export function readCertifiedRecord(
  row: Readonly<Record<string, unknown>>,
): CertifiedRecord {
  return Object.freeze({
    ...readStagedRecord(row),
    canonicalCertifiedRecord: readBytes(row, "canonical_certified_record"),
  });
}

/**
 * Projects one staged or completed recoverable re-anchor.
 *
 * @param row SQLite result row.
 * @returns The detached recoverable re-anchor.
 */
export function readRecoveredReanchor(
  row: Readonly<Record<string, unknown>>,
): RecoveredReanchor {
  const canonicalCompletedReanchor = readOptionalBytes(
    row,
    "canonical_completed_reanchor",
  );
  return Object.freeze({
    ...readStagedReanchor(row),
    ...(canonicalCompletedReanchor === undefined
      ? {}
      : { canonicalCompletedReanchor }),
  });
}

/**
 * Reads the optional singleton identity binding.
 *
 * @param database Exclusively owned endpoint database.
 * @returns The detached identity binding when one is committed.
 */
export function readStoredIdentity(
  database: DatabaseSync,
): IdentityBinding | undefined {
  const row = database
    .prepare(
      "SELECT agent_id, canonical_agent_card FROM identity_binding WHERE singleton = 1",
    )
    .get();
  return row === undefined
    ? undefined
    : Object.freeze({
        agentId: readText(row, "agent_id"),
        canonicalAgentCard: readBytes(row, "canonical_agent_card"),
      });
}

/**
 * Reads a required conversation position.
 *
 * @param database Exclusively owned endpoint database.
 * @param conversationId Opaque conversation identity.
 * @returns Its durable anchor, head, and local ordinal.
 */
export function readStoredPosition(
  database: DatabaseSync,
  conversationId: string,
): InternalPosition {
  const row = database
    .prepare(
      `SELECT conversation_id, membership_hash, current_anchor_hash,
              head_record_hash, head_ordinal
       FROM conversation_state WHERE conversation_id = ?`,
    )
    .get(conversationId);
  if (row === undefined) {
    throw new StoreSignal("not-found");
  }
  return Object.freeze({
    ...readConversationPosition(row),
    headOrdinal: readInteger(row, "head_ordinal"),
  });
}

/**
 * Projects one durable position row without its local ordinal.
 *
 * @param row SQLite result row.
 * @returns The detached conversation position.
 */
export function readConversationPosition(
  row: Readonly<Record<string, unknown>>,
): ConversationPosition {
  const headRecordHash = readOptionalText(row, "head_record_hash");
  return Object.freeze({
    conversationId: readText(row, "conversation_id"),
    membershipHash: readText(row, "membership_hash"),
    currentAnchorHash: readText(row, "current_anchor_hash"),
    ...(headRecordHash === undefined ? {} : { headRecordHash }),
  });
}

/**
 * Reads an optional staged record by stable private hash.
 *
 * @param database Exclusively owned endpoint database.
 * @param conversationId Opaque conversation identity.
 * @param recordHash Stable private record hash.
 * @returns The detached staged record when present.
 */
export function findStagedRecord(
  database: DatabaseSync,
  conversationId: string,
  recordHash: string,
): StagedRecord | undefined {
  const row = database
    .prepare(
      `SELECT conversation_id, record_hash, previous_record_hash,
              membership_hash, anchor_hash, canonical_record
       FROM staged_records WHERE conversation_id = ? AND record_hash = ?`,
    )
    .get(conversationId, recordHash);
  return row === undefined ? undefined : readStagedRecord(row);
}

/**
 * Projects one exact staged action-certified record.
 *
 * @param row SQLite result row.
 * @returns The detached staged record.
 */
export function readStagedRecord(
  row: Readonly<Record<string, unknown>>,
): StagedRecord {
  const previousRecordHash = readOptionalText(row, "previous_record_hash");
  return Object.freeze({
    conversationId: readText(row, "conversation_id"),
    recordHash: readText(row, "record_hash"),
    ...(previousRecordHash === undefined ? {} : { previousRecordHash }),
    membershipHash: readText(row, "membership_hash"),
    anchorHash: readText(row, "anchor_hash"),
    canonicalRecord: readBytes(row, "canonical_record"),
  });
}

/**
 * Projects one stable evidence value.
 *
 * @param row SQLite result row.
 * @returns The detached protocol evidence.
 */
export function readProtocolEvidence(
  row: Readonly<Record<string, unknown>>,
): ProtocolEvidence {
  const kind = readEvidenceKind(row);
  return Object.freeze({
    conversationId: readText(row, "conversation_id"),
    kind,
    subjectId: readText(row, "subject_id"),
    evidenceKey: readText(row, "evidence_key"),
    canonicalEvidence: readBytes(row, "canonical_evidence"),
  });
}

/**
 * Reads an optional staged re-anchor by stable body hash.
 *
 * @param database Exclusively owned endpoint database.
 * @param conversationId Opaque conversation identity.
 * @param anchorHash Stable private anchor hash.
 * @returns The detached staged re-anchor when present.
 */
export function findStagedReanchor(
  database: DatabaseSync,
  conversationId: string,
  anchorHash: string,
): StagedReanchor | undefined {
  const row = database
    .prepare(
      `SELECT conversation_id, anchor_hash, previous_anchor_hash,
              router_instance_id, selected_record_hash, canonical_body
       FROM reanchors WHERE conversation_id = ? AND anchor_hash = ?`,
    )
    .get(conversationId, anchorHash);
  return row === undefined ? undefined : readStagedReanchor(row);
}

/**
 * Projects one staged re-anchor body.
 *
 * @param row SQLite result row.
 * @returns The detached staged re-anchor.
 */
export function readStagedReanchor(
  row: Readonly<Record<string, unknown>>,
): StagedReanchor {
  return Object.freeze({
    conversationId: readText(row, "conversation_id"),
    anchorHash: readText(row, "anchor_hash"),
    previousAnchorHash: readText(row, "previous_anchor_hash"),
    routerInstanceId: readText(row, "router_instance_id"),
    selectedRecordHash: readText(row, "selected_record_hash"),
    canonicalBody: readBytes(row, "canonical_body"),
  });
}

/**
 * Requires two records with one stable hash to have identical bindings.
 *
 * @param left Previously retained record.
 * @param right Candidate record.
 */
export function requireSameRecord(
  left: StagedRecord,
  right: StagedRecord,
): void {
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.recordHash, right.recordHash);
  requireEqual(left.previousRecordHash, right.previousRecordHash);
  requireEqual(left.membershipHash, right.membershipHash);
  requireEqual(left.anchorHash, right.anchorHash);
  requireSameBytes(left.canonicalRecord, right.canonicalRecord);
}

/**
 * Requires two re-anchors with one hash to have identical body bindings.
 *
 * @param left Previously retained re-anchor.
 * @param right Candidate re-anchor.
 */
export function requireSameReanchor(
  left: StagedReanchor,
  right: StagedReanchor,
): void {
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.anchorHash, right.anchorHash);
  requireEqual(left.previousAnchorHash, right.previousAnchorHash);
  requireEqual(left.routerInstanceId, right.routerInstanceId);
  requireEqual(left.selectedRecordHash, right.selectedRecordHash);
  requireSameBytes(left.canonicalBody, right.canonicalBody);
}

function readEvidenceKind(
  row: Readonly<Record<string, unknown>>,
): ProtocolEvidence["kind"] {
  const kind = readText(row, "evidence_kind");
  if (
    kind !== "action" &&
    kind !== "durability" &&
    kind !== "catch-up" &&
    kind !== "reanchor"
  ) {
    throw new StoreSignal("corrupt");
  }
  return kind;
}
