/** @file Verified reconstruction of active protocol evidence from store rows. */

import { SignedMessage } from "@moltzap/identity";
import { Effect, type ParseResult, Schema } from "effect";
import type { EngineActionFold } from "../engine-types.js";
import type { EndpointRecovery, ProtocolEvidence } from "../store.js";
import {
  type ActionHash,
  ActionHash as ActionHashSchema,
  type ClientRepresentationError,
  decodeCanonical,
  type EvidenceStatement as EvidenceStatementValue,
  RecordHash,
  type RecordHash as RecordHashValue,
  verifyStableEvidence,
} from "../representation.js";
import { RouterWorkerPersistenceError } from "../router-worker/index.js";

type StoredEvidenceError =
  | ClientRepresentationError
  | ParseResult.ParseError
  | RouterWorkerPersistenceError;

interface FoldEvidenceTarget {
  readonly fold: EngineActionFold;
  readonly kind: "action" | "durability";
}

/**
 * Restore only evidence whose signer, subject, and conversation still match.
 * @param recovery Complete endpoint-store snapshot.
 * @param actionFolds Active folds indexed by verified action hash.
 * @param recordFolds Active folds indexed by verified record hash.
 * @returns Completion after every relevant row is verified and installed.
 */
export function recoverFoldEvidence(
  recovery: EndpointRecovery,
  actionFolds: Map<ActionHash, EngineActionFold>,
  recordFolds: Map<RecordHashValue, EngineActionFold>,
): Effect.Effect<void, StoredEvidenceError> {
  return Effect.forEach(
    recovery.evidence,
    (row) => {
      if (row.kind === "catch-up" || row.kind === "reanchor") {
        return Effect.void;
      }
      return foldForEvidence(row, actionFolds, recordFolds).pipe(
        Effect.flatMap((target) =>
          target === undefined
            ? Effect.fail(persistenceFailure())
            : restoreFoldEvidence(row, target),
        ),
      );
    },
    { concurrency: 1, discard: true },
  );
}

function foldForEvidence(
  row: ProtocolEvidence,
  actionFolds: Map<ActionHash, EngineActionFold>,
  recordFolds: Map<RecordHashValue, EngineActionFold>,
): Effect.Effect<FoldEvidenceTarget | undefined, StoredEvidenceError> {
  switch (row.kind) {
    case "action":
      return Schema.decodeUnknown(ActionHashSchema)(row.subjectId).pipe(
        Effect.map((hash) => actionFolds.get(hash)),
        Effect.map((fold) =>
          fold === undefined ? undefined : { fold, kind: "action" },
        ),
      );
    case "durability":
      return Schema.decodeUnknown(RecordHash)(row.subjectId).pipe(
        Effect.map((hash) => recordFolds.get(hash)),
        Effect.map((fold) =>
          fold === undefined ? undefined : { fold, kind: "durability" },
        ),
      );
    case "catch-up":
    case "reanchor":
      return Effect.succeed(undefined);
    default: {
      const exhaustive: never = row.kind;
      return exhaustive;
    }
  }
}

function restoreFoldEvidence(
  row: ProtocolEvidence,
  target: FoldEvidenceTarget,
): Effect.Effect<void, StoredEvidenceError> {
  return decodeCanonical(SignedMessage, row.canonicalEvidence).pipe(
    Effect.flatMap((message) => Schema.encode(SignedMessage)(message)),
    Effect.flatMap((representation) =>
      verifyStableEvidence({
        representation,
        membership: target.fold.conversation.membership,
      }),
    ),
    Effect.flatMap((verified) =>
      foldEvidenceMatches(row, target, verified.statement)
        ? Effect.sync(() => {
            const evidence =
              target.kind === "action"
                ? target.fold.actionEvidence
                : target.fold.durabilityEvidence;
            evidence.set(verified.message.senderAgentId, verified.message);
          })
        : Effect.fail(persistenceFailure()),
    ),
  );
}

function foldEvidenceMatches(
  row: ProtocolEvidence,
  target: FoldEvidenceTarget,
  statement: EvidenceStatementValue,
): boolean {
  if (
    row.conversationId !== target.fold.conversation.conversationId ||
    row.evidenceKey !== statement.signerAgentId
  ) {
    return false;
  }
  return target.kind === "action"
    ? actionEvidenceMatches(row, target.fold, statement)
    : durabilityEvidenceMatches(row, target.fold, statement);
}

function actionEvidenceMatches(
  row: ProtocolEvidence,
  fold: EngineActionFold,
  statement: EvidenceStatementValue,
): boolean {
  if (row.kind !== "action" || statement.kind !== "action_signature") {
    return false;
  }
  return (
    row.subjectId === fold.actionHash &&
    statement.actionHash === fold.actionHash
  );
}

function durabilityEvidenceMatches(
  row: ProtocolEvidence,
  fold: EngineActionFold,
  statement: EvidenceStatementValue,
): boolean {
  if (row.kind !== "durability" || statement.kind !== "durability_vote") {
    return false;
  }
  return (
    row.subjectId === fold.recordHash &&
    statement.recordHash === fold.recordHash
  );
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}
