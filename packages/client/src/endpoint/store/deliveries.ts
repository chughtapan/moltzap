/** @file Durable remote-message delivery, replay, and acknowledgment. */

import type { DatabaseSync } from "node:sqlite";
import { Either, Schema } from "effect";
import {
  copyBytes,
  mintDeliveryToken,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  StoreSignal,
  transaction,
} from "./database/index.js";
import { readPendingDelivery, readStoredIdentity } from "./rows/index.js";
import {
  type CertifiedRecord,
  DeliveryToken,
  type InboundDeliveryInput,
  type PendingDelivery,
  type StoreMutation,
} from "./types.js";

const deliveryColumns = `
  delivery_token, conversation_id, record_hash, recipient_agent_id,
  canonical_message, acknowledged
`;

/**
 * Reads unacknowledged deliveries in stable local commit order.
 *
 * @param database Exclusively owned endpoint database.
 * @returns Detached pending deliveries in durable insertion order.
 */
export function readPendingDeliveries(
  database: DatabaseSync,
): readonly PendingDelivery[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT ${deliveryColumns} FROM pending_deliveries
         WHERE acknowledged = 0 ORDER BY delivery_sequence`,
      )
      .all()
      .map(readPendingDelivery),
  );
}

/**
 * Reads every retained delivery, including acknowledged tombstones.
 *
 * @param database Exclusively owned endpoint database.
 * @returns Detached retained deliveries in durable insertion order.
 */
export function readRetainedDeliveries(
  database: DatabaseSync,
): readonly PendingDelivery[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT ${deliveryColumns} FROM pending_deliveries
         ORDER BY delivery_sequence`,
      )
      .all()
      .map(readPendingDelivery),
  );
}

/**
 * Durably acknowledges one delivery without deleting its collision tombstone.
 *
 * @param database Exclusively owned endpoint database.
 * @param deliveryToken Stable opaque delivery identity.
 * @returns Whether acknowledgment state advanced or was already retained.
 */
export function acknowledgeDelivery(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
): StoreMutation {
  Either.match(Schema.decodeUnknownEither(DeliveryToken)(deliveryToken), {
    onLeft: () => {
      throw new StoreSignal("invalid-input");
    },
    onRight: () => undefined,
  });
  return transaction(database, () => {
    const row = database
      .prepare(
        `SELECT ${deliveryColumns} FROM pending_deliveries
         WHERE delivery_token = ?`,
      )
      .get(deliveryToken);
    if (row === undefined) {
      throw new StoreSignal("not-found");
    }
    if (readPendingDelivery(row).acknowledged) {
      return "existing";
    }
    database
      .prepare(
        `UPDATE pending_deliveries SET acknowledged = 1
         WHERE delivery_token = ?`,
      )
      .run(deliveryToken);
    return "inserted";
  });
}

/**
 * Creates or validates the delivery coupled to one certified record.
 *
 * This function runs inside the record-promotion transaction after the
 * certified marker exists. It suppresses the local author's own post.
 *
 * @param database Exclusively owned endpoint database.
 * @param record Complete record whose certification is already durable.
 * @param delivery Canonical remote message, absent for the local author.
 * @returns Whether the delivery row was inserted or already retained.
 */
export function retainDeliveryInTransaction(
  database: DatabaseSync,
  record: CertifiedRecord,
  delivery?: InboundDeliveryInput,
): StoreMutation {
  const identity = readStoredIdentity(database);
  if (identity === undefined) {
    throw new StoreSignal("not-found");
  }
  if (record.authorAgentId === identity.agentId) {
    if (delivery !== undefined) {
      throw new StoreSignal("conflict");
    }
    return "existing";
  }
  if (delivery === undefined) {
    throw new StoreSignal("invalid-input");
  }
  requireText(delivery.recipientAgentId);
  requireBytes(delivery.canonicalMessage);
  requireEqual(identity.agentId, delivery.recipientAgentId);
  const existing = findRetainedDelivery(
    database,
    record.conversationId,
    record.recordHash,
  );
  if (existing !== undefined) {
    requireEqual(existing.recipientAgentId, delivery.recipientAgentId);
    requireSameBytes(existing.canonicalMessage, delivery.canonicalMessage);
    return "existing";
  }
  const deliveryToken = Schema.decodeUnknownSync(DeliveryToken)(
    mintDeliveryToken(readDeliveryTokens(database)),
  );
  database
    .prepare(
      `INSERT INTO pending_deliveries
        (delivery_token, conversation_id, record_hash, recipient_agent_id,
         canonical_message)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      deliveryToken,
      record.conversationId,
      record.recordHash,
      delivery.recipientAgentId,
      copyBytes(delivery.canonicalMessage),
    );
  return "inserted";
}

function findRetainedDelivery(
  database: DatabaseSync,
  conversationId: string,
  recordHash: string,
): PendingDelivery | undefined {
  const row = database
    .prepare(
      `SELECT ${deliveryColumns} FROM pending_deliveries
       WHERE conversation_id = ? AND record_hash = ?`,
    )
    .get(conversationId, recordHash);
  return row === undefined ? undefined : readPendingDelivery(row);
}

function readDeliveryTokens(database: DatabaseSync): ReadonlySet<string> {
  return new Set(
    database
      .prepare("SELECT delivery_token FROM pending_deliveries")
      .all()
      .map((row) => readText(row, "delivery_token")),
  );
}
