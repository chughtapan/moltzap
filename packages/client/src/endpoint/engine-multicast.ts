/** @file Generic MULTICAST action certification over an OpenFloor candidate. */

import { SignedMessage } from "@moltzap/identity";
import { Deferred, Effect, Schema } from "effect";
import {
  ActionBinding,
  ClientRepresentationError,
  hashAnchor,
  makeActionBinding,
  verifyStableEvidence,
} from "./representation.js";
import type { OpenFloorMulticastCandidate } from "./openfloor.js";
import { sameCanonical } from "./engine-durability.js";
import { queueOuterEvidence, queueOuterPacket } from "./engine-start.js";
import {
  type EngineMulticastFold,
  EngineReplyError,
  type EngineRuntime,
} from "./engine-types.js";

const representationFailure = () => new ClientRepresentationError();

const currentAnchorHash = (
  runtime: EngineRuntime,
  conversationId: OpenFloorMulticastCandidate["conversationId"],
) => {
  const conversation = runtime.conversations.get(conversationId);
  if (conversation === undefined) {
    return Effect.fail(representationFailure());
  }
  return conversation.currentAnchor.kind === "genesis_anchor"
    ? hashAnchor(conversation.currentAnchor)
    : Effect.succeed(conversation.currentAnchor.anchorHash);
};

const verifyCandidate = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
): Effect.Effect<void, ClientRepresentationError> =>
  Effect.gen(function* () {
    const conversation = runtime.conversations.get(candidate.conversationId);
    const head = conversation?.head;
    if (
      conversation === undefined ||
      head === undefined ||
      candidate.action.kind !== "multicast_action" ||
      candidate.action.conversationId !== candidate.conversationId ||
      candidate.action.beginDigest !== candidate.beginDigest ||
      candidate.action.membershipHash !== conversation.membership.hash ||
      candidate.membership.hash !== conversation.membership.hash ||
      candidate.action.previousRecordHash !== head.recordHash ||
      candidate.action.anchorHash !==
        (yield* currentAnchorHash(runtime, candidate.conversationId))
    ) {
      return yield* Effect.fail(representationFailure());
    }
    const representation = yield* Schema.encode(SignedMessage)(
      candidate.localActionSignature,
    ).pipe(Effect.mapError(representationFailure));
    const verified = yield* verifyStableEvidence({
      representation,
      membership: conversation.membership,
    });
    const expected = yield* makeActionBinding(candidate.action);
    if (
      verified.statement.kind !== "action_signature" ||
      verified.statement.signerAgentId !==
        runtime.input.localAgentCard.agentId ||
      !(yield* sameCanonical(
        ActionBinding,
        verified.statement.action,
        expected,
      ))
    ) {
      return yield* Effect.fail(representationFailure());
    }
  });

const installCandidate = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
  queueProposal: boolean,
): Effect.Effect<EngineMulticastFold, ClientRepresentationError> =>
  Effect.gen(function* () {
    yield* verifyCandidate(runtime, candidate);
    const retained = runtime.multicastFolds.get(candidate.beginDigest);
    if (retained !== undefined) {
      if (
        !(yield* sameCanonical(
          ActionBinding,
          yield* makeActionBinding(retained.action),
          yield* makeActionBinding(candidate.action),
        ))
      ) {
        return yield* Effect.fail(representationFailure());
      }
      return retained;
    }
    const competing = [...runtime.multicastFolds.values()].some(
      (fold) =>
        fold.conversationId === candidate.conversationId &&
        fold.certifiedRecord === undefined,
    );
    if (competing) {
      return yield* Effect.fail(representationFailure());
    }
    const conversation = runtime.conversations.get(candidate.conversationId);
    if (conversation === undefined) {
      return yield* Effect.fail(representationFailure());
    }
    const fold: EngineMulticastFold = {
      foldKind: "multicast",
      conversationId: candidate.conversationId,
      beginDigest: candidate.beginDigest,
      membership: candidate.membership,
      action: candidate.action,
      routerAnchor: conversation.currentAnchor,
      actionSignatures: new Map(),
      durabilityVotes: new Map(),
      actionSignatureQueued: true,
      durabilityVoteQueued: false,
      certifiedBroadcastQueued: false,
      completion: yield* Deferred.make<void, EngineReplyError>(),
    };
    runtime.multicastFolds.set(candidate.beginDigest, fold);
    if (queueProposal) {
      yield* queueOuterPacket(runtime, fold, {
        moltzapVersion: candidate.action.moltzapVersion,
        kind: "multicast_proposal",
        action: candidate.action,
      });
    }
    yield* queueOuterEvidence(runtime, fold, candidate.localActionSignature);
    return fold;
  });

/** Install and enqueue a locally admitted bound reply without direct folding. */
export const startLocalMulticast = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
): Effect.Effect<EngineMulticastFold, EngineReplyError> =>
  installCandidate(runtime, candidate, true).pipe(
    Effect.mapError(() => new EngineReplyError({ reason: "representation" })),
  );

/** Install one task-validated remote proposal and enqueue only our signature. */
export const acceptRemoteMulticast = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
): Effect.Effect<void, ClientRepresentationError> =>
  installCandidate(runtime, candidate, false).pipe(Effect.asVoid);
