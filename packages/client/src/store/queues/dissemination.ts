/** @file Durable action-certified-record send obligations and exact outbox attachment. */

import type { DatabaseSync } from "node:sqlite";
import type {
  DisseminationObligation,
  OutboundMessageInput,
  StoredOutboundMessage,
  StoreMutation,
} from "../types.js";
import {
  readOptionalText,
  readText,
  requireEqual,
  requireText,
  StoreSignal,
  transaction,
} from "../database/index.js";

/**
 * Retains the send obligation for a staged action-certified record inside
 * the transaction that stages it. The schema's foreign key refuses an
 * obligation for a record that is not staged.
 *
 * @param database Exclusively owned endpoint database.
 * @param obligation The staged record that must reach the durable outbox.
 * @returns Whether the obligation was inserted or already durable.
 */
export function retainDisseminationInTransaction(
  database: DatabaseSync,
  obligation: DisseminationObligation,
): StoreMutation {
  validateObligation(obligation);
  if (findOutboundId(database, obligation) !== undefined) {
    return "existing";
  }
  database
    .prepare(
      `INSERT INTO dissemination_obligations (conversation_id, record_hash)
       VALUES (?, ?)`,
    )
    .run(obligation.conversationId, obligation.recordHash);
  return "inserted";
}

/**
 * Atomically attaches one send obligation to its exact outbox row.
 *
 * @param database Exclusively owned endpoint database.
 * @param obligation Expected durable send obligation.
 * @param message Complete canonical outer envelope.
 * @param enqueueInTransaction The outbox insert, run inside this transaction
 * so the obligation and its envelope commit together.
 * @returns The current durable envelope under its stable outbox identity.
 */
export function enqueueDisseminationOutbound(
  database: DatabaseSync,
  obligation: DisseminationObligation,
  message: OutboundMessageInput,
  enqueueInTransaction: (
    database: DatabaseSync,
    message: OutboundMessageInput,
  ) => StoredOutboundMessage,
): StoredOutboundMessage {
  validateObligation(obligation);
  requireEqual(obligation.conversationId, message.conversationId);
  return transaction(database, () => {
    const retained = findOutboundId(database, obligation);
    if (retained === undefined) {
      throw new StoreSignal("not-found");
    }
    const outbound = enqueueInTransaction(database, message);
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
           WHERE conversation_id = ? AND record_hash = ?
             AND outbound_id IS NULL`,
        )
        .run(
          outbound.outboundId,
          obligation.conversationId,
          obligation.recordHash,
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
        `SELECT conversation_id, record_hash
         FROM dissemination_obligations WHERE outbound_id IS NULL
         ORDER BY obligation_sequence`,
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

interface RetainedDissemination {
  readonly outboundId?: string;
}

function findOutboundId(
  database: DatabaseSync,
  obligation: DisseminationObligation,
): RetainedDissemination | undefined {
  const row = database
    .prepare(
      `SELECT outbound_id FROM dissemination_obligations
       WHERE conversation_id = ? AND record_hash = ?`,
    )
    .get(obligation.conversationId, obligation.recordHash);
  if (row === undefined) {
    return undefined;
  }
  const outboundId = readOptionalText(row, "outbound_id");
  return Object.freeze(outboundId === undefined ? {} : { outboundId });
}

function validateObligation(obligation: DisseminationObligation): void {
  requireText(obligation.conversationId);
  requireText(obligation.recordHash);
}
