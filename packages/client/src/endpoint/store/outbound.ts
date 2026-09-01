/** @file Durable exact-envelope ownership across Router retries and restart. */

import type { DatabaseSync } from "node:sqlite";
import type {
  OutboundAttempt,
  OutboundMessageInput,
  StoredOutboundMessage,
  StoreMutation,
} from "./types.js";
import {
  copyBytes,
  readBytes,
  readInteger,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  StoreSignal,
  transaction,
} from "./database/index.js";

type OutboundDisposition = "accepted" | "discarded" | "pending";

interface RetainedOutbound {
  readonly outbound: StoredOutboundMessage;
  readonly initialCanonicalSignedMessage: Uint8Array;
  readonly attempted: boolean;
  readonly disposition: OutboundDisposition;
}

/**
 * Stages one complete outer envelope before it can reach Router transport.
 *
 * The initial MessageId remains the durable handle even when Router retry
 * identity loss requires a replacement outer envelope.
 *
 * @param database Exclusively owned endpoint database.
 * @param message Canonical complete initial outer message.
 * @returns The retained current envelope under its stable initial identity.
 */
export function enqueueOutbound(
  database: DatabaseSync,
  message: OutboundMessageInput,
): StoredOutboundMessage {
  validateMessageInput(message);
  return transaction(database, () =>
    enqueueOutboundInTransaction(database, message),
  );
}

/**
 * Retains one validated envelope inside a caller-owned SQLite transaction.
 * @param database Exclusively owned endpoint database.
 * @param message Canonical complete initial outer message.
 * @returns The retained current envelope under its stable initial identity.
 */
export function enqueueOutboundInTransaction(
  database: DatabaseSync,
  message: OutboundMessageInput,
): StoredOutboundMessage {
  validateMessageInput(message);
  requireConversation(database, message.conversationId);
  const existing = findOutbound(database, message.messageId);
  if (existing !== undefined) {
    requireEqual(existing.outbound.conversationId, message.conversationId);
    requireSameBytes(
      existing.initialCanonicalSignedMessage,
      message.canonicalSignedMessage,
    );
    return copyOutbound(existing.outbound);
  }
  requireMessageIdAvailable(database, message.messageId);
  database
    .prepare(
      `INSERT INTO outbound_messages
        (outbound_id, conversation_id, current_message_id,
         canonical_initial_signed_message,
         canonical_current_signed_message, attempted, disposition)
       VALUES (?, ?, ?, ?, ?, 0, 'pending')`,
    )
    .run(
      message.messageId,
      message.conversationId,
      message.messageId,
      copyBytes(message.canonicalSignedMessage),
      copyBytes(message.canonicalSignedMessage),
    );
  return copyOutbound({
    outboundId: message.messageId,
    ...message,
  });
}

/**
 * Selects the exact durable envelope and retry mode for one Router attempt.
 *
 * @param database Exclusively owned endpoint database.
 * @param outboundId Stable identity of the initial outer envelope.
 * @returns The current stored bytes, or an inactive terminal disposition.
 */
export function beginOutbound(
  database: DatabaseSync,
  outboundId: string,
): OutboundAttempt {
  requireText(outboundId);
  return transaction(database, () => {
    const retained = requireOutbound(database, outboundId);
    if (retained.disposition !== "pending") {
      return Object.freeze({ kind: "inactive" });
    }
    const mode = retained.attempted ? "retry" : "initial";
    if (!retained.attempted) {
      database
        .prepare(
          `UPDATE outbound_messages SET attempted = 1
           WHERE outbound_id = ? AND disposition = 'pending'`,
        )
        .run(outboundId);
    }
    return Object.freeze({
      kind: "pending",
      mode,
      outbound: copyOutbound(retained.outbound),
    });
  });
}

/**
 * Atomically replaces only one expected current outer envelope.
 *
 * @param database Exclusively owned endpoint database.
 * @param current Exact durable envelope that Router no longer recognizes.
 * @param replacement Fresh outer identity over the byte-identical body.
 * @returns The durable replacement under the unchanged outbox identity.
 */
export function replaceOutbound(
  database: DatabaseSync,
  current: StoredOutboundMessage,
  replacement: OutboundMessageInput,
): StoredOutboundMessage {
  validateStoredOutbound(current);
  validateMessageInput(replacement);
  requireEqual(current.conversationId, replacement.conversationId);
  if (current.messageId === replacement.messageId) {
    throw new StoreSignal("invalid-input");
  }
  return transaction(database, () => {
    const retained = requireOutbound(database, current.outboundId);
    requirePending(retained);
    requireSameOutbound(retained.outbound, current);
    requireMessageIdAvailable(database, replacement.messageId);
    database
      .prepare(
        `UPDATE outbound_messages
         SET current_message_id = ?, canonical_current_signed_message = ?,
             attempted = 0
         WHERE outbound_id = ? AND disposition = 'pending'`,
      )
      .run(
        replacement.messageId,
        copyBytes(replacement.canonicalSignedMessage),
        current.outboundId,
      );
    return copyOutbound({
      outboundId: current.outboundId,
      ...replacement,
    });
  });
}

/**
 * Marks one exact current envelope complete after Router accepts its bytes.
 *
 * @param database Exclusively owned endpoint database.
 * @param outbound Exact envelope whose Router digest was verified.
 * @returns Whether this call recorded acceptance or observed it already.
 */
export function completeOutbound(
  database: DatabaseSync,
  outbound: StoredOutboundMessage,
): StoreMutation {
  validateStoredOutbound(outbound);
  return transaction(database, () => {
    const retained = requireOutbound(database, outbound.outboundId);
    requireSameOutbound(retained.outbound, outbound);
    switch (retained.disposition) {
      case "accepted":
        return "existing";
      case "discarded":
        throw new StoreSignal("conflict");
      case "pending":
        database
          .prepare(
            `UPDATE outbound_messages SET disposition = 'accepted'
             WHERE outbound_id = ? AND disposition = 'pending'`,
          )
          .run(outbound.outboundId);
        return "inserted";
      default: {
        const exhaustive: never = retained.disposition;
        return exhaustive;
      }
    }
  });
}

/**
 * Atomically invalidates exact pending envelopes before protocol regeneration.
 *
 * @param database Exclusively owned endpoint database.
 * @param outbounds Complete expected-current envelopes to invalidate.
 * @returns Whether at least one pending envelope became inactive.
 */
export function discardOutbound(
  database: DatabaseSync,
  outbounds: readonly StoredOutboundMessage[],
): StoreMutation {
  const distinctIds = new Set<string>();
  for (const outbound of outbounds) {
    validateStoredOutbound(outbound);
    if (distinctIds.has(outbound.outboundId)) {
      throw new StoreSignal("invalid-input");
    }
    distinctIds.add(outbound.outboundId);
  }
  return transaction(database, () => {
    const retained = outbounds.map((outbound) => {
      const row = requireOutbound(database, outbound.outboundId);
      requireSameOutbound(row.outbound, outbound);
      if (row.disposition === "accepted") {
        throw new StoreSignal("conflict");
      }
      return row;
    });
    const inserted = retained.some(
      (outbound) => outbound.disposition === "pending",
    );
    for (const outbound of retained) {
      if (outbound.disposition === "pending") {
        database
          .prepare(
            `UPDATE dissemination_obligations SET outbound_id = NULL
             WHERE outbound_id = ?`,
          )
          .run(outbound.outbound.outboundId);
        database
          .prepare(
            `UPDATE outbound_messages SET disposition = 'discarded'
             WHERE outbound_id = ? AND disposition = 'pending'`,
          )
          .run(outbound.outbound.outboundId);
      }
    }
    return inserted ? "inserted" : "existing";
  });
}

/**
 * Reads every pending current envelope in durable insertion order.
 *
 * @param database Exclusively owned endpoint database.
 * @returns Detached pending envelopes, excluding accepted and discarded rows.
 */
export function readPendingOutbound(
  database: DatabaseSync,
): readonly StoredOutboundMessage[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT outbound_id, conversation_id, current_message_id,
                canonical_initial_signed_message,
                canonical_current_signed_message, attempted, disposition
         FROM outbound_messages WHERE disposition = 'pending'
         ORDER BY outbound_sequence`,
      )
      .all()
      .map((row) => copyOutbound(readOutbound(row).outbound)),
  );
}

function requireOutbound(
  database: DatabaseSync,
  outboundId: string,
): RetainedOutbound {
  const retained = findOutbound(database, outboundId);
  if (retained === undefined) {
    throw new StoreSignal("not-found");
  }
  return retained;
}

function findOutbound(
  database: DatabaseSync,
  outboundId: string,
): RetainedOutbound | undefined {
  const row = database
    .prepare(
      `SELECT outbound_id, conversation_id, current_message_id,
              canonical_initial_signed_message,
              canonical_current_signed_message, attempted, disposition
       FROM outbound_messages WHERE outbound_id = ?`,
    )
    .get(outboundId);
  return row === undefined ? undefined : readOutbound(row);
}

function readOutbound(
  row: Readonly<Record<string, unknown>>,
): RetainedOutbound {
  const attempted = readInteger(row, "attempted");
  if (attempted !== 0 && attempted !== 1) {
    throw new StoreSignal("corrupt");
  }
  return Object.freeze({
    outbound: Object.freeze({
      outboundId: readText(row, "outbound_id"),
      conversationId: readText(row, "conversation_id"),
      messageId: readText(row, "current_message_id"),
      canonicalSignedMessage: readBytes(
        row,
        "canonical_current_signed_message",
      ),
    }),
    initialCanonicalSignedMessage: readBytes(
      row,
      "canonical_initial_signed_message",
    ),
    attempted: attempted === 1,
    disposition: readDisposition(row),
  });
}

function readDisposition(
  row: Readonly<Record<string, unknown>>,
): OutboundDisposition {
  const disposition = readText(row, "disposition");
  switch (disposition) {
    case "accepted":
    case "discarded":
    case "pending":
      return disposition;
    default:
      throw new StoreSignal("corrupt");
  }
}

function requireConversation(
  database: DatabaseSync,
  conversationId: string,
): void {
  if (
    database
      .prepare(
        `SELECT 1 AS retained FROM conversation_state
         WHERE conversation_id = ?`,
      )
      .get(conversationId) === undefined
  ) {
    throw new StoreSignal("not-found");
  }
}

function requireMessageIdAvailable(
  database: DatabaseSync,
  messageId: string,
): void {
  if (
    database
      .prepare(
        `SELECT 1 AS retained FROM outbound_messages
         WHERE outbound_id = ? OR current_message_id = ? LIMIT 1`,
      )
      .get(messageId, messageId) !== undefined
  ) {
    throw new StoreSignal("conflict");
  }
}

function requirePending(retained: RetainedOutbound): void {
  if (retained.disposition !== "pending") {
    throw new StoreSignal("conflict");
  }
}

function validateStoredOutbound(outbound: StoredOutboundMessage): void {
  requireText(outbound.outboundId);
  validateMessageInput(outbound);
}

function validateMessageInput(message: OutboundMessageInput): void {
  requireText(message.conversationId);
  requireText(message.messageId);
  requireBytes(message.canonicalSignedMessage);
}

function requireSameOutbound(
  left: StoredOutboundMessage,
  right: StoredOutboundMessage,
): void {
  requireEqual(left.outboundId, right.outboundId);
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.messageId, right.messageId);
  requireSameBytes(left.canonicalSignedMessage, right.canonicalSignedMessage);
}

function copyOutbound(outbound: StoredOutboundMessage): StoredOutboundMessage {
  return Object.freeze({
    ...outbound,
    canonicalSignedMessage: copyBytes(outbound.canonicalSignedMessage),
  });
}
