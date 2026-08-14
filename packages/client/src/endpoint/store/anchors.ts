/** @file Atomic identity, START foundation, and Router-anchor transitions. */

import type { DatabaseSync } from "node:sqlite";
import type {
  CompletedReanchor,
  ConversationFoundation,
  IdentityBinding,
  StagedReanchor,
  StartIntent,
  StoreMutation,
} from "./types.js";
import {
  copyBytes,
  readBytes,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  StoreSignal,
  transaction,
} from "./database/index.js";
import {
  findStagedReanchor,
  readStoredIdentity,
  readStoredPosition,
  requireSameReanchor,
} from "./rows/index.js";

/** Singleton identity binding operations. */
export const bindIdentity = Object.freeze({
  read: readStoredIdentity,
  write: writeIdentity,
});

/**
 * Durably binds one caller-minted conversation to exact canonical START bytes.
 *
 * @param database Exclusively owned endpoint database.
 * @param intent Canonical START retry identity and bytes.
 * @returns Whether the same binding was inserted or already durable.
 */
export function bindStartIntent(
  database: DatabaseSync,
  intent: StartIntent,
): StoreMutation {
  requireText(intent.conversationId);
  requireBytes(intent.canonicalIntent);
  if (intent.completedRecordHash !== undefined) {
    throw new StoreSignal("invalid-input");
  }
  return transaction(database, () =>
    bindStartIntentInTransaction(database, intent),
  );
}

/**
 * Atomically persists the immutable membership and genesis Router anchor.
 *
 * @param database Exclusively owned endpoint database.
 * @param foundation Verified immutable conversation foundation.
 * @returns Whether the same foundation was inserted or already durable.
 */
export function putConversationFoundation(
  database: DatabaseSync,
  foundation: ConversationFoundation,
): StoreMutation {
  validateFoundation(foundation);
  return transaction(database, () => {
    requireStartIntent(database, foundation.conversationId);
    const existing = readFoundation(database, foundation.conversationId);
    if (existing !== undefined) {
      requireSameFoundation(existing, foundation);
      return "existing";
    }
    insertFoundation(database, foundation);
    return "inserted";
  });
}

/**
 * Durably stages at most one re-anchor proposal for one Router-instance scope.
 *
 * @param database Exclusively owned endpoint database.
 * @param reanchor Verified proposal body and stable hash.
 * @returns Whether the same proposal was inserted or already durable.
 */
export function stageReanchor(
  database: DatabaseSync,
  reanchor: StagedReanchor,
): StoreMutation {
  validateStagedReanchor(reanchor);
  return transaction(database, () =>
    stageReanchorInTransaction(database, reanchor),
  );
}

/**
 * Atomically makes a staged threshold-complete Router anchor current.
 *
 * @param database Exclusively owned endpoint database.
 * @param reanchor Verified completed re-anchor and threshold evidence.
 * @returns Whether completion advanced the current anchor or was idempotent.
 */
export function completeReanchor(
  database: DatabaseSync,
  reanchor: CompletedReanchor,
): StoreMutation {
  validateCompletedReanchor(reanchor);
  return transaction(database, () =>
    completeReanchorInTransaction(database, reanchor),
  );
}

/**
 * Atomically stages and completes exactly one verified catch-up anchor item.
 *
 * @param database Exclusively owned endpoint database.
 * @param reanchor One verified completed re-anchor from catch-up.
 * @returns Whether any durable state was added.
 */
export function applyCatchUpReanchor(
  database: DatabaseSync,
  reanchor: CompletedReanchor,
): StoreMutation {
  validateCompletedReanchor(reanchor);
  return transaction(database, () => {
    const staged = stageReanchorInTransaction(database, reanchor);
    const completed = completeReanchorInTransaction(database, reanchor);
    return staged === "inserted" || completed === "inserted"
      ? "inserted"
      : "existing";
  });
}

function writeIdentity(
  database: DatabaseSync,
  binding: IdentityBinding,
): StoreMutation {
  requireText(binding.agentId);
  requireBytes(binding.canonicalAgentCard);
  return transaction(database, () => {
    const existing = readStoredIdentity(database);
    if (existing !== undefined) {
      requireEqual(existing.agentId, binding.agentId);
      requireSameBytes(existing.canonicalAgentCard, binding.canonicalAgentCard);
      return "existing";
    }
    database
      .prepare(
        `INSERT INTO identity_binding
          (singleton, agent_id, canonical_agent_card) VALUES (1, ?, ?)`,
      )
      .run(binding.agentId, copyBytes(binding.canonicalAgentCard));
    return "inserted";
  });
}

function bindStartIntentInTransaction(
  database: DatabaseSync,
  intent: StartIntent,
): StoreMutation {
  const existing = database
    .prepare(
      "SELECT canonical_intent FROM start_intents WHERE conversation_id = ?",
    )
    .get(intent.conversationId);
  if (existing !== undefined) {
    requireSameBytes(
      readBytes(existing, "canonical_intent"),
      intent.canonicalIntent,
    );
    return "existing";
  }
  database
    .prepare(
      "INSERT INTO start_intents (conversation_id, canonical_intent) VALUES (?, ?)",
    )
    .run(intent.conversationId, copyBytes(intent.canonicalIntent));
  return "inserted";
}

function readFoundation(
  database: DatabaseSync,
  conversationId: string,
): ConversationFoundation | undefined {
  const row = database
    .prepare(
      `SELECT membership.membership_hash, membership.canonical_membership,
              anchor.anchor_hash, anchor.canonical_anchor
       FROM memberships AS membership
       JOIN anchors AS anchor
         ON anchor.conversation_id = membership.conversation_id
        AND anchor.previous_anchor_hash IS NULL
       WHERE membership.conversation_id = ?`,
    )
    .get(conversationId);
  return row === undefined
    ? undefined
    : Object.freeze({
        conversationId,
        membershipHash: readText(row, "membership_hash"),
        canonicalMembership: readBytes(row, "canonical_membership"),
        anchorHash: readText(row, "anchor_hash"),
        canonicalAnchor: readBytes(row, "canonical_anchor"),
      });
}

function insertFoundation(
  database: DatabaseSync,
  foundation: ConversationFoundation,
): void {
  database
    .prepare(
      `INSERT INTO memberships
        (conversation_id, membership_hash, canonical_membership)
       VALUES (?, ?, ?)`,
    )
    .run(
      foundation.conversationId,
      foundation.membershipHash,
      copyBytes(foundation.canonicalMembership),
    );
  database
    .prepare(
      `INSERT INTO anchors
        (conversation_id, anchor_hash, canonical_anchor) VALUES (?, ?, ?)`,
    )
    .run(
      foundation.conversationId,
      foundation.anchorHash,
      copyBytes(foundation.canonicalAnchor),
    );
  database
    .prepare(
      `INSERT INTO conversation_state
        (conversation_id, membership_hash, current_anchor_hash, head_ordinal)
       VALUES (?, ?, ?, -1)`,
    )
    .run(
      foundation.conversationId,
      foundation.membershipHash,
      foundation.anchorHash,
    );
}

function stageReanchorInTransaction(
  database: DatabaseSync,
  reanchor: StagedReanchor,
): StoreMutation {
  const existing = findStagedReanchor(
    database,
    reanchor.conversationId,
    reanchor.anchorHash,
  );
  if (existing !== undefined) {
    requireSameReanchor(existing, reanchor);
    return "existing";
  }
  requireUnclaimedReanchorScope(database, reanchor);
  requireReanchorPosition(database, reanchor);
  insertStagedReanchor(database, reanchor);
  return "inserted";
}

function completeReanchorInTransaction(
  database: DatabaseSync,
  reanchor: CompletedReanchor,
): StoreMutation {
  const staged = findStagedReanchor(
    database,
    reanchor.conversationId,
    reanchor.anchorHash,
  );
  if (staged === undefined) {
    throw new StoreSignal("not-found");
  }
  requireSameReanchor(staged, reanchor);
  if (hasAnchor(database, reanchor.conversationId, reanchor.anchorHash)) {
    return "existing";
  }
  requireReanchorPosition(database, reanchor);
  insertCompletedReanchor(database, reanchor);
  return "inserted";
}

function requireUnclaimedReanchorScope(
  database: DatabaseSync,
  reanchor: StagedReanchor,
): void {
  const scoped = database
    .prepare(
      `SELECT anchor_hash FROM reanchors
       WHERE conversation_id = ? AND previous_anchor_hash = ?
         AND router_instance_id = ?`,
    )
    .get(
      reanchor.conversationId,
      reanchor.previousAnchorHash,
      reanchor.routerInstanceId,
    );
  if (scoped !== undefined) {
    throw new StoreSignal("conflict");
  }
}

function requireReanchorPosition(
  database: DatabaseSync,
  reanchor: StagedReanchor,
): void {
  const position = readStoredPosition(database, reanchor.conversationId);
  requireEqual(position.currentAnchorHash, reanchor.previousAnchorHash);
  requireEqual(position.headRecordHash, reanchor.selectedRecordHash);
  const unpromoted = database
    .prepare(
      `SELECT staged.record_hash
       FROM staged_records AS staged
       LEFT JOIN certified_records AS certified
         ON certified.conversation_id = staged.conversation_id
        AND certified.record_hash = staged.record_hash
       WHERE staged.conversation_id = ? AND certified.record_hash IS NULL
       LIMIT 1`,
    )
    .get(reanchor.conversationId);
  if (unpromoted !== undefined) {
    throw new StoreSignal("conflict");
  }
}

function insertStagedReanchor(
  database: DatabaseSync,
  reanchor: StagedReanchor,
): void {
  database
    .prepare(
      `INSERT INTO reanchors
        (conversation_id, anchor_hash, previous_anchor_hash,
         router_instance_id, selected_record_hash, canonical_body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      reanchor.conversationId,
      reanchor.anchorHash,
      reanchor.previousAnchorHash,
      reanchor.routerInstanceId,
      reanchor.selectedRecordHash,
      copyBytes(reanchor.canonicalBody),
    );
}

function insertCompletedReanchor(
  database: DatabaseSync,
  reanchor: CompletedReanchor,
): void {
  database
    .prepare(
      `INSERT INTO anchors
        (conversation_id, anchor_hash, previous_anchor_hash,
         selected_record_hash, canonical_anchor)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      reanchor.conversationId,
      reanchor.anchorHash,
      reanchor.previousAnchorHash,
      reanchor.selectedRecordHash,
      copyBytes(reanchor.canonicalCompletedReanchor),
    );
  database
    .prepare(
      `UPDATE reanchors SET canonical_completed_reanchor = ?
       WHERE conversation_id = ? AND anchor_hash = ?`,
    )
    .run(
      copyBytes(reanchor.canonicalCompletedReanchor),
      reanchor.conversationId,
      reanchor.anchorHash,
    );
  database
    .prepare(
      `UPDATE conversation_state SET current_anchor_hash = ?
       WHERE conversation_id = ?`,
    )
    .run(reanchor.anchorHash, reanchor.conversationId);
}

function requireStartIntent(
  database: DatabaseSync,
  conversationId: string,
): Readonly<Record<string, unknown>> {
  const row = database
    .prepare(
      `SELECT canonical_intent, completed_record_hash FROM start_intents
       WHERE conversation_id = ?`,
    )
    .get(conversationId);
  if (row === undefined) {
    throw new StoreSignal("not-found");
  }
  return row;
}

function hasAnchor(
  database: DatabaseSync,
  conversationId: string,
  anchorHash: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS retained FROM anchors
         WHERE conversation_id = ? AND anchor_hash = ?`,
      )
      .get(conversationId, anchorHash) !== undefined
  );
}

function validateFoundation(foundation: ConversationFoundation): void {
  requireText(foundation.conversationId);
  requireText(foundation.membershipHash);
  requireBytes(foundation.canonicalMembership);
  requireText(foundation.anchorHash);
  requireBytes(foundation.canonicalAnchor);
}

function validateCompletedReanchor(reanchor: CompletedReanchor): void {
  validateStagedReanchor(reanchor);
  requireBytes(reanchor.canonicalCompletedReanchor);
}

function validateStagedReanchor(reanchor: StagedReanchor): void {
  requireText(reanchor.conversationId);
  requireText(reanchor.anchorHash);
  requireText(reanchor.previousAnchorHash);
  requireText(reanchor.routerInstanceId);
  requireText(reanchor.selectedRecordHash);
  requireBytes(reanchor.canonicalBody);
}

function requireSameFoundation(
  left: ConversationFoundation,
  right: ConversationFoundation,
): void {
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.membershipHash, right.membershipHash);
  requireSameBytes(left.canonicalMembership, right.canonicalMembership);
  requireEqual(left.anchorHash, right.anchorHash);
  requireSameBytes(left.canonicalAnchor, right.canonicalAnchor);
}
