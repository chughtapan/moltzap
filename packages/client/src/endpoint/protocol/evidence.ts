/** @file Stable evidence routing and verification for active protocol folds. */

import { SignedMessage } from "@moltzap/identity";
import { Effect, Schema } from "effect";
import type { EngineActionFold, EngineRuntime } from "../engine-types.js";
import type { RouterWorkerIngress } from "../router-worker/index.js";
import {
  ClientRepresentationError,
  decodeCanonical,
  type DecodedOuterBody,
  EvidenceStatement,
  type VerifiedEvidence,
  verifyOuterMessage,
  verifyStableEvidence,
} from "../representation.js";

/** One active fold selected by the target of a stable evidence statement. */
export type EvidenceRoute =
  | Readonly<{ fold: EngineActionFold; kind: "action" }>
  | Readonly<{ fold: EngineActionFold; kind: "durability" }>;

/**
 * Locate the active fold named by a stable evidence message.
 * @param runtime Engine whose active folds may receive the evidence.
 * @param message Decoded stable inner evidence message.
 * @returns The matching fold and evidence kind, when still active.
 */
export const evidenceRoute = (
  runtime: EngineRuntime,
  message: SignedMessage,
): Effect.Effect<EvidenceRoute | undefined, ClientRepresentationError> =>
  decodeCanonical(EvidenceStatement, message.body).pipe(
    Effect.map((statement) => {
      switch (statement.kind) {
        case "action_signature": {
          const fold = runtime.actionFolds.get(statement.actionHash);
          return fold === undefined ? undefined : { fold, kind: "action" };
        }
        case "durability_vote": {
          const fold = runtime.recordFolds.get(statement.recordHash);
          return fold === undefined ? undefined : { fold, kind: "durability" };
        }
        case "catch_up_attestation":
        case "reanchor_vote":
          return undefined;
        default: {
          const exhaustive: never = statement;
          return exhaustive;
        }
      }
    }),
  );

/**
 * Check that verified evidence targets the fold selected by its decoded body.
 * @param route Active fold and evidence role selected from the statement.
 * @param statement Cryptographically verified evidence statement.
 * @returns Whether every fold-specific binding matches.
 */
export function evidenceMatchesFold(
  route: EvidenceRoute,
  statement: VerifiedEvidence["statement"],
): boolean {
  switch (route.kind) {
    case "action":
      return actionEvidenceMatchesFold(route.fold, statement);
    case "durability":
      return durabilityEvidenceMatchesFold(route.fold, statement);
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}

/**
 * Verify one evidence message against its outer sender and fixed membership.
 * @param ingress Authenticated Router ingress carrying the outer message.
 * @param message Stable self-addressed inner evidence message.
 * @param route Active fold selected from the evidence statement.
 * @returns Cryptographically verified evidence and decoded statement.
 */
export function verifiedEvidenceForRoute(
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessage,
  route: EvidenceRoute,
): Effect.Effect<VerifiedEvidence, ClientRepresentationError> {
  return Effect.gen(function* () {
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: route.fold.conversation.membership,
    });
    const representation = yield* Schema.encode(SignedMessage)(message).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new ClientRepresentationError()),
      ),
    );
    return yield* verifyStableEvidence({
      representation,
      membership: route.fold.conversation.membership,
    });
  }).pipe(Effect.withSpan("verifiedEvidenceForRoute"));
}

function actionEvidenceMatchesFold(
  fold: EngineActionFold,
  statement: VerifiedEvidence["statement"],
): boolean {
  return (
    statement.kind === "action_signature" &&
    statement.actionHash === fold.actionHash
  );
}

function durabilityEvidenceMatchesFold(
  fold: EngineActionFold,
  statement: VerifiedEvidence["statement"],
): boolean {
  if (statement.kind !== "durability_vote" || fold.recordHash === undefined) {
    return false;
  }
  return (
    statement.recordHash === fold.recordHash &&
    statement.conversationId === fold.conversation.conversationId &&
    statement.membershipHash === fold.conversation.membership.hash
  );
}
