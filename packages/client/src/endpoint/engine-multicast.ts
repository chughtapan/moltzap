/** @file Generic MULTICAST action certification over an OpenFloor candidate. */

import { SignedMessage } from "@moltzap/identity";
import { Deferred, Effect, Schema } from "effect";
import type { OpenFloorMulticastCandidate } from "./openfloor.js";
import { sameCanonical } from "./engine-durability.js";
import { queueOuterEvidence, queueOuterPacket } from "./engine-start.js";
import {
  type EngineConversation,
  type EngineMulticastFold,
  EngineReplyError,
  type EngineRuntime,
} from "./engine-types.js";
import {
  ActionBinding,
  ClientRepresentationError,
  hashAnchor,
  makeActionBinding,
  verifyStableEvidence,
} from "./representation.js";

const representationFailure = () => new ClientRepresentationError();

const makeReplyCompletion = (): Effect.Effect<
  EngineMulticastFold["completion"]
> => Deferred.make();

const currentAnchorHash = (conversation: EngineConversation) =>
  conversation.currentAnchor.kind === "genesis_anchor"
    ? hashAnchor(conversation.currentAnchor)
    : Effect.succeed(conversation.currentAnchor.anchorHash);

const candidateConversation = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
): Effect.Effect<EngineConversation, ClientRepresentationError> => {
  const conversation = runtime.conversations.get(candidate.conversationId);
  return conversation === undefined
    ? Effect.fail(representationFailure())
    : Effect.succeed(conversation);
};

const verifyCandidate = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
): Effect.Effect<void, ClientRepresentationError> =>
  Effect.gen(function* () {
    const conversation = yield* candidateConversation(runtime, candidate);
    const head = conversation.head;
    if (head === undefined || candidate.action.kind !== "multicast_action") {
      return yield* Effect.fail(representationFailure());
    }
    const anchorHash = yield* currentAnchorHash(conversation);
    const matchesCurrentFold = [
      candidate.action.conversationId === candidate.conversationId,
      candidate.action.beginDigest === candidate.beginDigest,
      candidate.action.membershipHash === conversation.membership.hash,
      candidate.membership.hash === conversation.membership.hash,
      candidate.action.previousRecordHash === head.recordHash,
      candidate.action.anchorHash === anchorHash,
    ].every(Boolean);
    if (!matchesCurrentFold) {
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
    if (verified.statement.kind !== "action_signature") {
      return yield* Effect.fail(representationFailure());
    }
    if (
      verified.statement.signerAgentId !== runtime.input.localAgentCard.agentId
    ) {
      return yield* Effect.fail(representationFailure());
    }
    if (
      !(yield* sameCanonical(
        ActionBinding,
        verified.statement.action,
        expected,
      ))
    ) {
      return yield* Effect.fail(representationFailure());
    }
  });

const retainedCandidate = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
): Effect.Effect<EngineMulticastFold | undefined, ClientRepresentationError> =>
  Effect.gen(function* () {
    const retained = runtime.multicastFolds.get(candidate.beginDigest);
    if (retained === undefined) {
      return undefined;
    }
    const retainedBinding = yield* makeActionBinding(retained.action);
    const candidateBinding = yield* makeActionBinding(candidate.action);
    if (
      !(yield* sameCanonical(ActionBinding, retainedBinding, candidateBinding))
    ) {
      return yield* Effect.fail(representationFailure());
    }
    return retained;
  });

const makeCandidateFold = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
): Effect.Effect<EngineMulticastFold, ClientRepresentationError> =>
  Effect.gen(function* () {
    const competing = [...runtime.multicastFolds.values()].some(
      (fold) =>
        fold.conversationId === candidate.conversationId &&
        fold.certifiedRecord === undefined,
    );
    if (competing) {
      return yield* Effect.fail(representationFailure());
    }
    const conversation = yield* candidateConversation(runtime, candidate);
    return {
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
      completion: yield* makeReplyCompletion(),
    };
  });

const installCandidate = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
  queueProposal: boolean,
): Effect.Effect<EngineMulticastFold, ClientRepresentationError> =>
  Effect.gen(function* () {
    yield* verifyCandidate(runtime, candidate);
    const retained = yield* retainedCandidate(runtime, candidate);
    if (retained !== undefined) {
      return retained;
    }
    const fold = yield* makeCandidateFold(runtime, candidate);
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

/**
 * Install and enqueue a locally admitted bound reply without direct folding.
 * @param runtime Endpoint state and durable dependencies.
 * @param candidate Task-validated multicast candidate.
 * @returns The installed or matching retained multicast fold.
 */
export const startLocalMulticast = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
): Effect.Effect<EngineMulticastFold, EngineReplyError> =>
  installCandidate(runtime, candidate, true).pipe(
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.fail(new EngineReplyError({ reason: "representation" })),
    ),
  );

/**
 * Install one task-validated remote proposal and enqueue only our signature.
 * @param runtime Endpoint state and durable dependencies.
 * @param candidate Task-validated remote multicast candidate.
 * @returns Completion after the candidate and local signature are queued.
 */
export const acceptRemoteMulticast = (
  runtime: EngineRuntime,
  candidate: OpenFloorMulticastCandidate,
): Effect.Effect<void, ClientRepresentationError> =>
  installCandidate(runtime, candidate, false).pipe(Effect.asVoid);
