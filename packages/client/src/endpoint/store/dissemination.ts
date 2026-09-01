/** @file Durable record-dissemination obligations and exact outbox attachment. */

import type { DatabaseSync } from "node:sqlite";
import type {
  DisseminationKind,
  DisseminationObligation,
  OutboundMessageInput,
  StoredOutboundMessage,
  StoreMutation,
} from "./types.js";
import {
  readOptionalText,
  readText,
  requireEqual,
  requireText,
  StoreSignal,
  transaction,
} from "./database/index.js";
import { enqueueOutboundInTransaction } from "./outbound.js";

/**
 * Retains one logical packet requirement inside a record-state transaction.
 *
 * @param database Exclusively owned endpoint database.
 * @param obligation Exact record packet that must reach the durable outbox.
 * @returns Whether the obligation was inserted or already durable.
 */
export function retainDisseminationInTransaction(
  database: DatabaseSync,
  obligation: DisseminationObligation,
): StoreMutation {
  validateObligation(obligation);
  requireRecordState(database, obligation);
  const existing = findObligation(database, obligation);
  if (existing !== undefined) {
    return "existing";
  }
  database
    .prepare(
      `INSERT INTO dissemination_obligations
        (conversation_id, record_hash, packet_kind)
       VALUES (?, ?, ?)`,
    )
    .run(obligation.conversationId, obligation.recordHash, obligation.kind);
  return "inserted";
}

/**
 * Atomically attaches one logical packet requirement to its exact outbox row.
 *
 * @param database Exclusively owned endpoint database.
 * @param obligation Expected durable packet requirement.
 * @param message Complete canonical outer envelope.
 * @returns The current durable envelope under its stable outbox identity.
 */
export function enqueueDisseminationOutbound(
  database: DatabaseSync,
  obligation: DisseminationObligation,
  message: OutboundMessageInput,
): StoredOutboundMessage {
  validateObligation(obligation);
  requireEqual(obligation.conversationId, message.conversationId);
  return transaction(database, () => {
    const retained = requireObligation(database, obligation);
    const outbound = enqueueOutboundInTransaction(database, message);
    if (
      retained.outboundId !== undefined &&
      retained.outboundId !== outbound.outboundId
    ) {
      throw new StoreSignal("conflict");
    }
    if (retained.outboundId === undefined) {
      database
        .prepare(
          `UPDATE dissemination_obligations SET outbound_id = ?
           WHERE conversation_id = ? AND record_hash = ? AND packet_kind = ?
             AND outbound_id IS NULL`,
        )
        .run(
          outbound.outboundId,
          obligation.conversationId,
          obligation.recordHash,
          obligation.kind,
        );
    }
    return outbound;
  });
}

/**
 * Reads unattached obligations in their durable insertion order.
 * @param database Exclusively owned endpoint database.
 * @returns Exact obligations that do not yet own an outbox envelope.
 */
export function readPendingDissemination(
  database: DatabaseSync,
): readonly DisseminationObligation[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT conversation_id, record_hash, packet_kind
         FROM dissemination_obligations WHERE outbound_id IS NULL
         ORDER BY obligation_sequence`,
      )
      .all()
      .map(readObligation),
  );
}

interface RetainedDissemination {
  readonly obligation: DisseminationObligation;
  readonly outboundId?: string;
}

function requireObligation(
  database: DatabaseSync,
  obligation: DisseminationObligation,
): RetainedDissemination {
  const retained = findObligation(database, obligation);
  if (retained === undefined) {
    throw new StoreSignal("not-found");
  }
  requireSameObligation(retained.obligation, obligation);
  return retained;
}

function findObligation(
  database: DatabaseSync,
  obligation: DisseminationObligation,
): RetainedDissemination | undefined {
  const row = database
    .prepare(
      `SELECT conversation_id, record_hash, packet_kind, outbound_id
       FROM dissemination_obligations
       WHERE conversation_id = ? AND record_hash = ? AND packet_kind = ?`,
    )
    .get(obligation.conversationId, obligation.recordHash, obligation.kind);
  return row === undefined ? undefined : readRetainedDissemination(row);
}

function readRetainedDissemination(
  row: Readonly<Record<string, unknown>>,
): RetainedDissemination {
  const outboundId = readOptionalText(row, "outbound_id");
  return Object.freeze({
    obligation: readObligation(row),
    ...(outboundId === undefined ? {} : { outboundId }),
  });
}

function readObligation(
  row: Readonly<Record<string, unknown>>,
): DisseminationObligation {
  return Object.freeze({
    conversationId: readText(row, "conversation_id"),
    recordHash: readText(row, "record_hash"),
    kind: readDisseminationKind(row),
  });
}

function readDisseminationKind(
  row: Readonly<Record<string, unknown>>,
): DisseminationKind {
  const kind = readText(row, "packet_kind");
  switch (kind) {
    case "action-certified-record":
    case "certified-record":
      return kind;
    default:
      throw new StoreSignal("corrupt");
  }
}

function validateObligation(obligation: DisseminationObligation): void {
  requireText(obligation.conversationId);
  requireText(obligation.recordHash);
}

function requireRecordState(
  database: DatabaseSync,
  obligation: DisseminationObligation,
): void {
  const retained = findRecordState(database, obligation);
  if (retained === undefined) {
    throw new StoreSignal("not-found");
  }
}

function findRecordState(
  database: DatabaseSync,
  obligation: DisseminationObligation,
): Readonly<Record<string, unknown>> | undefined {
  switch (obligation.kind) {
    case "action-certified-record":
      return database
        .prepare(
          `SELECT 1 AS retained FROM staged_records
           WHERE conversation_id = ? AND record_hash = ?`,
        )
        .get(obligation.conversationId, obligation.recordHash);
    case "certified-record":
      return database
        .prepare(
          `SELECT 1 AS retained FROM certified_records
           WHERE conversation_id = ? AND record_hash = ?`,
        )
        .get(obligation.conversationId, obligation.recordHash);
    default: {
      const exhaustive: never = obligation.kind;
      return exhaustive;
    }
  }
}

function requireSameObligation(
  left: DisseminationObligation,
  right: DisseminationObligation,
): void {
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.recordHash, right.recordHash);
  requireEqual(left.kind, right.kind);
}
