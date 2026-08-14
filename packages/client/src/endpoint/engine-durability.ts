/** @file START record staging, durability evidence, and local promotion. */

import {
  type AgentId,
  MOLTZAP_VERSION,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Deferred, Effect, Schema, SubscriptionRef } from "effect";
import type { EngineActionFold, EngineRuntime } from "./engine-types.js";
import type { EndpointStoreError, StoreMutation } from "./store.js";
import {
  assembleActionCertifiedRecord,
  queueOuterEvidence,
  queueOuterPacket,
} from "./engine-start.js";
import {
  ActionCertifiedRecord,
  type ActionCertifiedRecord as ActionCertifiedRecordValue,
  type AnchorHash,
  CertifiedRecord,
  type CertifiedRecord as CertifiedRecordValue,
  type ClientRepresentationError,
  compareAgentIds,
  durabilityThreshold,
  encodeCanonical,
  hashAnchor,
  type RecordHash,
  signEvidenceMessage,
  verifyActionCertifiedRecord,
  verifyCertifiedRecord,
  verifyStableEvidence,
} from "./representation.js";
import { RouterWorkerPersistenceError } from "./router-worker.js";

const blocked = (): RouterWorkerPersistenceError =>
  new RouterWorkerPersistenceError();

/**
 * Compare two schema values by their canonical bytes.
 * @param schema Schema that defines the canonical representation.
 * @param left First value to compare.
 * @param right Second value to compare.
 * @returns An effect that reports whether the canonical encodings match.
 */
export const sameCanonical = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  left: A,
  right: A,
): Effect.Effect<boolean, ClientRepresentationError, R> =>
  Effect.all([
    encodeCanonical(schema, left),
    encodeCanonical(schema, right),
  ]).pipe(
    Effect.map(
      ([leftBytes, rightBytes]) =>
        leftBytes.length === rightBytes.length &&
        leftBytes.every((byte, index) => byte === rightBytes[index]),
    ),
  );

type PersistEvidenceArguments = readonly [
  runtime: EngineRuntime,
  conversationId: string,
  kind: "action" | "durability",
  subjectId: string,
  signerAgentId: AgentId,
  message: SignedMessageValue,
];

/**
 * Merge one canonical evidence message into durable endpoint state.
 * @param args Runtime, evidence binding, signer, and signed message.
 * @returns The idempotent store mutation.
 */
export const persistEvidence = (...args: PersistEvidenceArguments) => {
  const [runtime, conversationId, kind, subjectId, signerAgentId, message] =
    args;
  return encodeCanonical(SignedMessage, message).pipe(
    Effect.mapError(blocked),
    Effect.flatMap((canonicalEvidence) =>
      runtime.input.store.mergeEvidence({
        conversationId,
        kind,
        subjectId,
        evidenceKey: signerAgentId,
        canonicalEvidence,
      }),
    ),
  );
};

/**
 * Persist an action-certified record before any durability vote is emitted.
 * @param runtime Endpoint engine state and dependencies.
 * @param conversation Action fold that owns the staged record.
 * @param record Action-certified record to stage.
 * @param recordHash Canonical hash of the staged record.
 * @returns The idempotent staging mutation.
 */
export const stageEngineRecord = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  record: ActionCertifiedRecordValue,
  recordHash: RecordHash,
) =>
  encodeCanonical(ActionCertifiedRecord, record).pipe(
    Effect.mapError(blocked),
    Effect.flatMap((canonicalRecord) =>
      runtime.input.store.stageRecord({
        conversationId: conversation.conversationId,
        recordHash,
        membershipHash: conversation.membership.hash,
        anchorHash: conversation.action.anchorHash,
        canonicalRecord,
        ...(conversation.action.previousRecordHash === null
          ? {}
          : {
              previousRecordHash: conversation.action.previousRecordHash,
            }),
      }),
    ),
  );

const markDurabilityVoteQueued = (conversation: EngineActionFold): void => {
  conversation.durabilityVoteQueued = true;
};

const retainActionCertifiedRecord = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  record: ActionCertifiedRecordValue,
  recordHash: RecordHash,
): void => {
  conversation.actionCertifiedRecord = record;
  conversation.recordHash = recordHash;
  runtime.recordFolds.set(recordHash, conversation);
};

const queueLocalDurabilityVote = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    if (
      conversation.durabilityVoteQueued ||
      conversation.recordHash === undefined
    ) {
      return;
    }
    const vote = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "durability_vote",
        signerAgentId: runtime.input.localAgentCard.agentId,
        conversationId: conversation.conversationId,
        membershipHash: conversation.membership.hash,
        recordHash: conversation.recordHash,
      },
      agentCard: runtime.input.localAgentCard,
      signingAuthority: runtime.input.signingAuthority,
    }).pipe(Effect.mapError(blocked));
    yield* queueOuterEvidence(runtime, conversation, vote).pipe(
      Effect.mapError(blocked),
    );
    markDurabilityVoteQueued(conversation);
  });

/**
 * Stage and retain an action-certified record, then queue the local vote.
 * @param runtime Endpoint engine state and dependencies.
 * @param conversation Action fold that adopts the record.
 * @param record Action-certified record to adopt.
 * @param recordHash Canonical hash of the adopted record.
 * @returns An effect that completes after the local durability vote is queued.
 */
export const adoptActionCertifiedRecord = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  record: ActionCertifiedRecordValue,
  recordHash: RecordHash,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    yield* stageEngineRecord(runtime, conversation, record, recordHash);
    retainActionCertifiedRecord(runtime, conversation, record, recordHash);
    yield* queueLocalDurabilityVote(runtime, conversation);
  }).pipe(Effect.withSpan("adoptActionCertifiedRecord"));

/**
 * Assemble and broadcast a certificate once every fixed member has signed.
 * @param runtime Endpoint engine state and dependencies.
 * @param conversation Action fold whose signatures may be complete.
 * @returns An effect that leaves incomplete signature sets unchanged.
 */
export const maybeCertifyAction = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    if (
      conversation.actionCertifiedRecord !== undefined ||
      conversation.actionSignatures.size !==
        conversation.membership.members.length
    ) {
      return;
    }
    const assembled = yield* assembleActionCertifiedRecord(conversation).pipe(
      Effect.mapError(blocked),
    );
    yield* verifyActionCertifiedRecord({
      record: assembled.record,
      registrySignerPublicKey: runtime.input.registrySignerPublicKey,
    }).pipe(Effect.mapError(blocked));
    yield* adoptActionCertifiedRecord(
      runtime,
      conversation,
      assembled.record,
      assembled.recordHash,
    );
    yield* queueOuterPacket(runtime, conversation, assembled.record).pipe(
      Effect.mapError(blocked),
    );
  }).pipe(Effect.withSpan("maybeCertifyAction"));

interface CanonicalCertifiedRecord {
  readonly canonicalRecord: Uint8Array;
  readonly canonicalCertifiedRecord: Uint8Array;
}

const encodeCertifiedRecord = (
  certified: CertifiedRecordValue,
): Effect.Effect<CanonicalCertifiedRecord, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const canonicalCertifiedRecord = yield* encodeCanonical(
      CertifiedRecord,
      certified,
    ).pipe(Effect.mapError(blocked));
    const canonicalRecord = yield* encodeCanonical(
      ActionCertifiedRecord,
      certified.actionCertifiedRecord,
    ).pipe(Effect.mapError(blocked));
    return { canonicalCertifiedRecord, canonicalRecord };
  });

const promoteCertifiedRecord = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  certified: CertifiedRecordValue,
  canonical: CanonicalCertifiedRecord,
): Effect.Effect<StoreMutation, EndpointStoreError> =>
  runtime.input.store.promoteRecord({
    conversationId: conversation.conversationId,
    recordHash: certified.recordHash,
    membershipHash: conversation.membership.hash,
    anchorHash: conversation.action.anchorHash,
    canonicalRecord: canonical.canonicalRecord,
    canonicalCertifiedRecord: canonical.canonicalCertifiedRecord,
    ...(conversation.action.previousRecordHash === null
      ? {}
      : { previousRecordHash: conversation.action.previousRecordHash }),
  });

const retainCertifiedRecord = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  certified: CertifiedRecordValue,
): void => {
  conversation.certifiedRecord = certified;
  const retained = runtime.conversations.get(conversation.conversationId);
  if (retained !== undefined) {
    retained.head = {
      recordHash: certified.recordHash,
      action: certified.actionCertifiedRecord.action,
      certifiedRecord: certified,
    };
  }
};

const advanceRetainedAnchor = (
  runtime: EngineRuntime,
  conversation: Extract<EngineActionFold, { readonly foldKind: "multicast" }>,
): void => {
  const retained = runtime.conversations.get(conversation.conversationId);
  if (retained !== undefined) {
    retained.currentAnchor = conversation.routerAnchor;
  }
};

const completeActionWaiter = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
): Effect.Effect<void> => {
  if (conversation.foldKind === "start") {
    const completion = runtime.completions.get(conversation.conversationId);
    return completion === undefined
      ? Effect.void
      : Deferred.succeed(completion, undefined);
  }
  advanceRetainedAnchor(runtime, conversation);
  return Deferred.succeed(conversation.completion, undefined);
};

const markCertifiedBroadcastQueued = (conversation: EngineActionFold): void => {
  conversation.certifiedBroadcastQueued = true;
};

const queueCertifiedBroadcast = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  certified: CertifiedRecordValue,
  mutation: StoreMutation,
): Effect.Effect<void, RouterWorkerPersistenceError> => {
  if (mutation !== "inserted" || conversation.certifiedBroadcastQueued) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    yield* queueOuterPacket(runtime, conversation, certified).pipe(
      Effect.mapError(blocked),
    );
    markCertifiedBroadcastQueued(conversation);
  });
};

const currentAnchorHash = (
  conversation: EngineActionFold,
): Effect.Effect<AnchorHash, RouterWorkerPersistenceError> => {
  if (conversation.foldKind !== "start") {
    return Effect.succeed(conversation.action.anchorHash);
  }
  return conversation.currentAnchor.kind === "genesis_anchor"
    ? hashAnchor(conversation.currentAnchor).pipe(Effect.mapError(blocked))
    : Effect.succeed(conversation.currentAnchor.anchorHash);
};

const notifyOpenFloor = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  certified: CertifiedRecordValue,
  mutation: StoreMutation,
): Effect.Effect<void, RouterWorkerPersistenceError> => {
  const openFloor = runtime.openFloor;
  if (mutation !== "inserted" || openFloor === undefined) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const anchorHash = yield* currentAnchorHash(conversation);
    yield* openFloor
      .certifiedHead({
        conversationId: conversation.conversationId,
        membership: conversation.membership,
        currentAnchorHash: anchorHash,
        recordHash: certified.recordHash,
        record: certified,
      })
      .pipe(Effect.mapError(blocked));
  });
};

/**
 * Atomically promote one certified record and publish its local consequences.
 * @param runtime Endpoint engine state and dependencies.
 * @param conversation Action fold promoted by the record.
 * @param certified Fully certified record to promote.
 * @returns An effect that completes after waiters and observers are updated.
 */
export const completeActionRecord = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  certified: CertifiedRecordValue,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const canonical = yield* encodeCertifiedRecord(certified);
    const mutation = yield* promoteCertifiedRecord(
      runtime,
      conversation,
      certified,
      canonical,
    );
    retainCertifiedRecord(runtime, conversation, certified);
    yield* completeActionWaiter(runtime, conversation);
    yield* queueCertifiedBroadcast(runtime, conversation, certified, mutation);
    yield* SubscriptionRef.update(runtime.revision, (revision) => revision + 1);
    yield* notifyOpenFloor(runtime, conversation, certified, mutation);
  }).pipe(Effect.withSpan("completeActionRecord"));

const assembleCertifiedRecord = (
  conversation: EngineActionFold,
): Effect.Effect<CertifiedRecordValue, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const record = conversation.actionCertifiedRecord;
    const recordHash = conversation.recordHash;
    if (record === undefined || recordHash === undefined) {
      return yield* Effect.fail(blocked());
    }
    const messages = [...conversation.durabilityVotes.values()].sort(
      (left, right) => compareAgentIds(left.senderAgentId, right.senderAgentId),
    );
    const encoded = yield* Effect.forEach(
      messages,
      (message) => Schema.encode(SignedMessage)(message),
      { concurrency: 1 },
    ).pipe(Effect.mapError(blocked));
    const first = encoded[0];
    if (first === undefined) {
      return yield* Effect.fail(blocked());
    }
    return {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "certified_record",
      recordHash,
      actionCertifiedRecord: record,
      routerAnchor:
        conversation.foldKind === "start"
          ? conversation.currentAnchor
          : conversation.routerAnchor,
      durabilityVotes: [first, ...encoded.slice(1)],
    };
  });

/**
 * Promote a staged record once the durability threshold is satisfied.
 * @param runtime Endpoint engine state and dependencies.
 * @param conversation Action fold whose durability votes may be sufficient.
 * @returns An effect that leaves an incomplete vote set unchanged.
 */
export const maybePromote = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    if (
      conversation.certifiedRecord !== undefined ||
      conversation.durabilityVotes.size <
        durabilityThreshold(conversation.membership.members.length)
    ) {
      return;
    }
    const certified = yield* assembleCertifiedRecord(conversation);
    yield* verifyCertifiedRecord({
      record: certified,
      registrySignerPublicKey: runtime.input.registrySignerPublicKey,
    }).pipe(Effect.mapError(blocked));
    yield* completeActionRecord(runtime, conversation, certified);
  }).pipe(Effect.withSpan("maybePromote"));

const retainCertifiedVote = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  certified: CertifiedRecordValue,
  representation: unknown,
): Effect.Effect<void, RouterWorkerPersistenceError | EndpointStoreError> =>
  Effect.gen(function* () {
    const { message, statement } = yield* verifyStableEvidence({
      representation,
      membership: conversation.membership,
    }).pipe(Effect.mapError(blocked));
    if (statement.kind !== "durability_vote") {
      return yield* Effect.fail(blocked());
    }
    yield* persistEvidence(
      runtime,
      conversation.conversationId,
      "durability",
      certified.recordHash,
      statement.signerAgentId,
      message,
    );
    conversation.durabilityVotes.set(statement.signerAgentId, message);
  });

/**
 * Verify and durably retain every vote carried by a certified record.
 * @param runtime Endpoint engine state and dependencies.
 * @param conversation Action fold that retains the verified votes.
 * @param certified Certified record carrying the votes.
 * @returns An effect that completes after all votes are retained in order.
 */
export const retainCertifiedVotes = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  certified: CertifiedRecordValue,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.forEach(
    certified.durabilityVotes,
    (representation) =>
      retainCertifiedVote(runtime, conversation, certified, representation),
    { concurrency: 1, discard: true },
  );

const completeRecoveredStart = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
): Effect.Effect<void> => {
  if (conversation.foldKind !== "start") {
    return Effect.void;
  }
  const completion = runtime.completions.get(conversation.conversationId);
  return completion === undefined
    ? Effect.void
    : Deferred.succeed(completion, undefined);
};

const resumeDurabilityVote = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
): Effect.Effect<void, RouterWorkerPersistenceError> => {
  const retainedVote = conversation.durabilityVotes.get(
    runtime.input.localAgentCard.agentId,
  );
  if (retainedVote === undefined) {
    return queueLocalDurabilityVote(runtime, conversation);
  }
  if (conversation.durabilityVoteQueued) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    yield* queueOuterEvidence(runtime, conversation, retainedVote).pipe(
      Effect.mapError(blocked),
    );
    markDurabilityVoteQueued(conversation);
  });
};

const resumeActionCertifiedFold = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  actionCertifiedRecord: ActionCertifiedRecordValue,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    yield* queueOuterPacket(runtime, conversation, actionCertifiedRecord).pipe(
      Effect.mapError(blocked),
    );
    yield* resumeDurabilityVote(runtime, conversation);
    yield* maybePromote(runtime, conversation);
  });

const markActionSignatureQueued = (conversation: EngineActionFold): void => {
  conversation.actionSignatureQueued = true;
};

const resumeActionSignature = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
): Effect.Effect<void, RouterWorkerPersistenceError> => {
  const retainedSignature = conversation.actionSignatures.get(
    runtime.input.localAgentCard.agentId,
  );
  if (retainedSignature === undefined || conversation.actionSignatureQueued) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    yield* queueOuterEvidence(runtime, conversation, retainedSignature).pipe(
      Effect.mapError(blocked),
    );
    markActionSignatureQueued(conversation);
  });
};

/**
 * Requeue only deterministic consequences of one recovered durable action fold.
 * @param runtime Endpoint engine state and dependencies.
 * @param conversation Recovered action fold to resume.
 * @returns An effect that completes after all recoverable work is requeued.
 */
export const resumeActionFold = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> => {
  if (conversation.certifiedRecord !== undefined) {
    return completeRecoveredStart(runtime, conversation).pipe(
      Effect.withSpan("resumeActionFold"),
    );
  }
  if (conversation.actionCertifiedRecord !== undefined) {
    return resumeActionCertifiedFold(
      runtime,
      conversation,
      conversation.actionCertifiedRecord,
    ).pipe(Effect.withSpan("resumeActionFold"));
  }
  return resumeActionSignature(runtime, conversation).pipe(
    Effect.withSpan("resumeActionFold"),
  );
};
