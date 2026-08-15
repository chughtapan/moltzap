/** @file Reconstruction of durable action folds without runtime attention. */

import { SignedMessage } from "@moltzap/identity";
import { Deferred, Effect, Schema } from "effect";
import type { ConversationId } from "../contract.js";
import type {
  EndpointEngineInput,
  EngineActionFold,
  EngineConversation,
  EngineMulticastFold,
} from "./engine-types.js";
import type { EndpointRecovery, StoredAnchor } from "./store.js";
import { sameCanonical } from "./engine-durability.js";
import {
  ActionBinding,
  ActionCertifiedRecord,
  type ActionCertifiedRecord as ActionCertifiedRecordValue,
  type BeginDigest,
  CertifiedRecord,
  type CertifiedRecord as CertifiedRecordValue,
  ClientRepresentationError,
  CompletedReanchor,
  decodeCanonical,
  GenesisAnchor,
  hashAnchor,
  makeActionBinding,
  type RecordHash,
  verifyActionCertifiedRecord,
  verifyCertifiedRecord,
  verifyCompletedReanchor,
  verifyStableEvidence,
} from "./representation.js";

interface DecodedStagedRecord {
  readonly record: ActionCertifiedRecordValue;
  readonly recordHash: RecordHash;
}

interface RecoveredStartInputs {
  readonly action: EngineConversation["action"];
  readonly canonicalIntent: Uint8Array;
  readonly genesis: StoredAnchor;
  readonly membership: EngineConversation["membership"];
  readonly position: EndpointRecovery["positions"][number];
}

/** All durable fold indexes reconstructed as one coherent snapshot. */
export interface RecoveredEngineState {
  readonly conversations: Map<ConversationId, EngineConversation>;
  readonly multicastFolds: Map<BeginDigest, EngineMulticastFold>;
  readonly recordFolds: Map<RecordHash, EngineActionFold>;
}

const failure = (): ClientRepresentationError =>
  new ClientRepresentationError();

const makeReplyCompletion = (): Effect.Effect<
  EngineMulticastFold["completion"]
> => Deferred.make();

const requireRecovered = <Value>(
  value?: Value,
): Effect.Effect<Value, ClientRepresentationError> => {
  if (value === undefined) {
    return Effect.fail(failure());
  }
  const recovered: Value = value;
  return Effect.succeed(recovered);
};

const startIntent = (
  recovery: EndpointRecovery,
  conversationId: ConversationId,
) =>
  recovery.startIntents.find(
    (intent) => intent.conversationId === conversationId,
  );

const storedAnchor = (
  recovery: EndpointRecovery,
  conversationId: ConversationId,
  anchorHash: string,
) =>
  recovery.anchors.find(
    (anchor) =>
      anchor.conversationId === conversationId &&
      anchor.anchorHash === anchorHash,
  );

const decodeAnchor = (
  stored: StoredAnchor,
  conversation: Pick<EngineConversation, "conversationId" | "membership">,
): Effect.Effect<
  EngineConversation["currentAnchor"],
  ClientRepresentationError
> =>
  stored.previousAnchorHash === undefined
    ? decodeCanonical(GenesisAnchor, stored.canonicalAnchor).pipe(
        Effect.flatMap((anchor) =>
          Effect.gen(function* () {
            if (
              anchor.conversationId !== conversation.conversationId ||
              anchor.membershipHash !== conversation.membership.hash ||
              (yield* hashAnchor(anchor)) !== stored.anchorHash
            ) {
              return yield* Effect.fail(failure());
            }
            return anchor;
          }),
        ),
      )
    : decodeCanonical(CompletedReanchor, stored.canonicalAnchor).pipe(
        Effect.flatMap((anchor) =>
          verifyCompletedReanchor({
            completed: anchor,
            membership: conversation.membership,
          }).pipe(
            Effect.filterOrFail(
              (anchorHash) => anchorHash === stored.anchorHash,
              failure,
            ),
            Effect.as(anchor),
          ),
        ),
      );

const decodeStaged = (
  input: EndpointEngineInput,
  staged: EndpointRecovery["stagedRecords"][number],
): Effect.Effect<DecodedStagedRecord, ClientRepresentationError> =>
  Effect.gen(function* () {
    const record = yield* decodeCanonical(
      ActionCertifiedRecord,
      staged.canonicalRecord,
    );
    const verified = yield* verifyActionCertifiedRecord({
      record,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
    const matchesStoredRecord = [
      record.action.conversationId === staged.conversationId,
      record.action.membershipHash === staged.membershipHash,
      record.action.anchorHash === staged.anchorHash,
      verified.recordHash === staged.recordHash,
      (record.action.previousRecordHash ?? undefined) ===
        staged.previousRecordHash,
    ].every(Boolean);
    if (!matchesStoredRecord) {
      return yield* Effect.fail(failure());
    }
    return { record, recordHash: verified.recordHash };
  });

const recoverStartInputs = (
  input: EndpointEngineInput,
  recovery: EndpointRecovery,
  decoded: DecodedStagedRecord,
): Effect.Effect<RecoveredStartInputs, ClientRepresentationError> =>
  Effect.gen(function* () {
    const action = decoded.record.action;
    if (action.kind !== "start_action") {
      return yield* Effect.fail(failure());
    }
    const verified = yield* verifyActionCertifiedRecord({
      record: decoded.record,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
    const canonicalIntent = (yield* requireRecovered(
      startIntent(recovery, action.conversationId),
    )).canonicalIntent;
    const genesis = yield* requireRecovered(
      recovery.anchors.find(
        (anchor) =>
          anchor.conversationId === action.conversationId &&
          anchor.previousAnchorHash === undefined,
      ),
    );
    const position = yield* requireRecovered(
      recovery.positions.find(
        (candidate) => candidate.conversationId === action.conversationId,
      ),
    );
    if (
      genesis.anchorHash !== action.anchorHash ||
      position.membershipHash !== verified.membership.hash
    ) {
      return yield* Effect.fail(failure());
    }
    return {
      action,
      canonicalIntent,
      genesis,
      membership: verified.membership,
      position,
    };
  });

const makeConversation = (
  input: EndpointEngineInput,
  recovery: EndpointRecovery,
  decoded: DecodedStagedRecord,
): Effect.Effect<EngineConversation, ClientRepresentationError> =>
  Effect.gen(function* () {
    const { action, canonicalIntent, genesis, membership, position } =
      yield* recoverStartInputs(input, recovery, decoded);
    const genesisAnchor = yield* decodeAnchor(genesis, {
      conversationId: action.conversationId,
      membership,
    });
    if (genesisAnchor.kind !== "genesis_anchor") {
      return yield* Effect.fail(failure());
    }
    const current = yield* requireRecovered(
      storedAnchor(recovery, action.conversationId, position.currentAnchorHash),
    );
    const conversation: EngineConversation = {
      foldKind: "start",
      conversationId: action.conversationId,
      canonicalIntent,
      membership,
      genesisAnchor,
      currentAnchor: genesisAnchor,
      action,
      actionSignatures: new Map(),
      durabilityVotes: new Map(),
      actionSignatureQueued: false,
      durabilityVoteQueued: false,
      certifiedBroadcastQueued: false,
      actionCertifiedRecord: decoded.record,
      recordHash: decoded.recordHash,
    };
    conversation.currentAnchor = yield* decodeAnchor(current, conversation);
    return conversation;
  });

const makeMulticastFold = (
  recovery: EndpointRecovery,
  conversation: EngineConversation,
  decoded: DecodedStagedRecord,
): Effect.Effect<EngineMulticastFold, ClientRepresentationError> =>
  Effect.gen(function* () {
    const action = decoded.record.action;
    if (
      action.kind !== "multicast_action" ||
      action.membershipHash !== conversation.membership.hash
    ) {
      return yield* Effect.fail(failure());
    }
    const anchor = storedAnchor(
      recovery,
      action.conversationId,
      action.anchorHash,
    );
    if (anchor === undefined) {
      return yield* Effect.fail(failure());
    }
    return {
      foldKind: "multicast",
      conversationId: action.conversationId,
      beginDigest: action.beginDigest,
      membership: conversation.membership,
      action,
      routerAnchor: yield* decodeAnchor(anchor, conversation),
      actionSignatures: new Map(),
      durabilityVotes: new Map(),
      actionSignatureQueued: false,
      durabilityVoteQueued: false,
      certifiedBroadcastQueued: false,
      actionCertifiedRecord: decoded.record,
      recordHash: decoded.recordHash,
      completion: yield* makeReplyCompletion(),
    };
  });

const evidenceMatchesFold = (
  fold: EngineActionFold,
  item: EndpointRecovery["evidence"][number],
): boolean => {
  if (item.conversationId !== fold.conversationId) {
    return false;
  }
  if (item.kind === "action") {
    return (
      item.subjectId === (fold.action.beginDigest ?? fold.action.anchorHash)
    );
  }
  return item.kind === "durability" && item.subjectId === fold.recordHash;
};

const retainEvidence = (
  fold: EngineActionFold,
  item: EndpointRecovery["evidence"][number],
): Effect.Effect<void, ClientRepresentationError> =>
  decodeCanonical(SignedMessage, item.canonicalEvidence).pipe(
    Effect.flatMap((message) =>
      Schema.encode(SignedMessage)(message).pipe(
        Effect.mapError(failure),
        Effect.flatMap((representation) =>
          verifyStableEvidence({ representation, membership: fold.membership }),
        ),
      ),
    ),
    Effect.flatMap(({ message, statement }) => {
      if (statement.kind === "action_signature" && item.kind === "action") {
        return Effect.gen(function* () {
          const expected = yield* makeActionBinding(fold.action);
          if (
            !(yield* sameCanonical(ActionBinding, statement.action, expected))
          ) {
            return yield* Effect.fail(failure());
          }
          fold.actionSignatures.set(statement.signerAgentId, message);
        });
      }
      if (
        statement.kind === "durability_vote" &&
        item.kind === "durability" &&
        statement.recordHash === fold.recordHash
      ) {
        fold.durabilityVotes.set(statement.signerAgentId, message);
        return Effect.void;
      }
      return Effect.fail(failure());
    }),
  );

const hydrateEvidence = (
  recovery: EndpointRecovery,
  fold: EngineActionFold,
): Effect.Effect<void, ClientRepresentationError> =>
  Effect.forEach(
    recovery.evidence.filter((item) => evidenceMatchesFold(fold, item)),
    (item) => retainEvidence(fold, item),
    { concurrency: 1, discard: true },
  );

const retainCertifiedVotes = (
  fold: EngineActionFold,
  certified: CertifiedRecordValue,
): Effect.Effect<void, ClientRepresentationError> =>
  Effect.forEach(
    certified.durabilityVotes,
    (representation) =>
      verifyStableEvidence({
        representation,
        membership: fold.membership,
      }).pipe(
        Effect.flatMap(({ message, statement }) =>
          statement.kind === "durability_vote" &&
          statement.recordHash === certified.recordHash
            ? Effect.sync(() =>
                fold.durabilityVotes.set(statement.signerAgentId, message),
              )
            : Effect.fail(failure()),
        ),
      ),
    { concurrency: 1, discard: true },
  );

const hydrateCertifiedRecords = (
  input: EndpointEngineInput,
  recovery: EndpointRecovery,
  state: RecoveredEngineState,
): Effect.Effect<void, ClientRepresentationError> =>
  Effect.forEach(
    recovery.certifiedRecords,
    (stored) =>
      Effect.gen(function* () {
        const certified = yield* decodeCanonical(
          CertifiedRecord,
          stored.canonicalCertifiedRecord,
        );
        yield* verifyCertifiedRecord({
          record: certified,
          registrySignerPublicKey: input.registrySignerPublicKey,
        });
        const fold = state.recordFolds.get(certified.recordHash);
        if (fold === undefined || certified.recordHash !== stored.recordHash) {
          return yield* Effect.fail(failure());
        }
        fold.certifiedRecord = certified;
        fold.certifiedBroadcastQueued = true;
        yield* retainCertifiedVotes(fold, certified);
        if (fold.foldKind === "multicast") {
          yield* Deferred.succeed(fold.completion, undefined);
        }
      }),
    { concurrency: 1, discard: true },
  );

const projectDurableHeads = (
  recovery: EndpointRecovery,
  state: RecoveredEngineState,
): Effect.Effect<void, ClientRepresentationError> =>
  Effect.forEach(
    state.conversations.values(),
    (conversation) => {
      const position = recovery.positions.find(
        (candidate) => candidate.conversationId === conversation.conversationId,
      );
      if (position?.headRecordHash === undefined) {
        return Effect.void;
      }
      const fold = [...state.recordFolds.values()].find(
        (candidate) =>
          candidate.conversationId === conversation.conversationId &&
          candidate.recordHash === position.headRecordHash,
      );
      const certified = fold?.certifiedRecord;
      if (fold === undefined || certified === undefined) {
        return Effect.fail(failure());
      }
      conversation.head = {
        recordHash: certified.recordHash,
        action: certified.actionCertifiedRecord.action,
        certifiedRecord: certified,
      };
      return Effect.void;
    },
    { concurrency: 1, discard: true },
  );

const recoverConversations = (
  input: EndpointEngineInput,
  recovery: EndpointRecovery,
  decoded: readonly DecodedStagedRecord[],
): Effect.Effect<
  Map<ConversationId, EngineConversation>,
  ClientRepresentationError
> =>
  Effect.gen(function* () {
    const conversations = new Map<ConversationId, EngineConversation>();
    for (const staged of decoded) {
      if (staged.record.action.kind !== "start_action") {
        continue;
      }
      const conversation = yield* makeConversation(input, recovery, staged);
      if (conversations.has(conversation.conversationId)) {
        return yield* Effect.fail(failure());
      }
      conversations.set(conversation.conversationId, conversation);
    }
    return conversations;
  });

const retainRecoveredFold = (
  recovery: EndpointRecovery,
  state: RecoveredEngineState,
  staged: DecodedStagedRecord,
  fold: EngineActionFold,
): Effect.Effect<void, ClientRepresentationError> => {
  const conflicts =
    state.recordFolds.has(staged.recordHash) ||
    (fold.foldKind === "multicast" &&
      state.multicastFolds.has(fold.beginDigest));
  if (conflicts) {
    return Effect.fail(failure());
  }
  state.recordFolds.set(staged.recordHash, fold);
  if (fold.foldKind === "multicast") {
    state.multicastFolds.set(fold.beginDigest, fold);
  }
  return hydrateEvidence(recovery, fold);
};

const recoverActionFolds = (
  recovery: EndpointRecovery,
  state: RecoveredEngineState,
  decoded: readonly DecodedStagedRecord[],
): Effect.Effect<void, ClientRepresentationError> =>
  Effect.forEach(
    decoded,
    (staged) => {
      const action = staged.record.action;
      const conversation = state.conversations.get(action.conversationId);
      if (conversation === undefined) {
        return Effect.fail(failure());
      }
      return Effect.gen(function* () {
        const fold: EngineActionFold =
          action.kind === "start_action"
            ? conversation
            : yield* makeMulticastFold(recovery, conversation, staged);
        yield* retainRecoveredFold(recovery, state, staged, fold);
      });
    },
    { concurrency: 1, discard: true },
  );

/**
 * Recover every staged action fold and the exact durable current head.
 * @param input Endpoint cryptographic and durable dependencies.
 * @param recovery Coherent durable snapshot to reconstruct.
 * @returns Every reconstructed conversation, action fold, and record index.
 */
export const recoverEngineState = (
  input: EndpointEngineInput,
  recovery: EndpointRecovery,
): Effect.Effect<RecoveredEngineState, ClientRepresentationError> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.forEach(
      recovery.stagedRecords,
      (staged) => decodeStaged(input, staged),
      { concurrency: 1 },
    );
    const conversations = yield* recoverConversations(input, recovery, decoded);
    const state: RecoveredEngineState = {
      conversations,
      multicastFolds: new Map(),
      recordFolds: new Map(),
    };
    yield* recoverActionFolds(recovery, state, decoded);
    yield* hydrateCertifiedRecords(input, recovery, state);
    yield* projectDurableHeads(recovery, state);
    return state;
  }).pipe(Effect.withSpan("recoverEngineState"));
