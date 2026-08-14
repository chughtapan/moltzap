/** @file START record staging, durability evidence, and local promotion. */

import {
  type AgentId,
  MOLTZAP_VERSION,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Deferred, Effect, Schema, SubscriptionRef } from "effect";
import {
  ActionBinding,
  ActionCertifiedRecord,
  type ActionCertifiedRecord as ActionCertifiedRecordValue,
  CertifiedRecord,
  type CertifiedRecord as CertifiedRecordValue,
  ClientRepresentationError,
  compareAgentIds,
  durabilityThreshold,
  encodeCanonical,
  hashAnchor,
  makeActionBinding,
  type RecordHash,
  signEvidenceMessage,
  verifyActionCertifiedRecord,
  verifyCertifiedRecord,
  verifyStableEvidence,
} from "./representation.js";
import {
  assembleActionCertifiedRecord,
  queueOuterEvidence,
  queueOuterPacket,
} from "./engine-start.js";
import type { EngineActionFold, EngineRuntime } from "./engine-types.js";
import { RouterWorkerPersistenceError } from "./router-worker.js";
import { EndpointStoreError } from "./store.js";

const blocked = (): RouterWorkerPersistenceError =>
  new RouterWorkerPersistenceError();

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

export const persistEvidence = (
  runtime: EngineRuntime,
  conversationId: string,
  kind: "action" | "durability",
  subjectId: string,
  signerAgentId: AgentId,
  message: SignedMessageValue,
) =>
  encodeCanonical(SignedMessage, message).pipe(
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
    conversation.durabilityVoteQueued = true;
  });

export const adoptActionCertifiedRecord = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  record: ActionCertifiedRecordValue,
  recordHash: RecordHash,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    yield* stageEngineRecord(runtime, conversation, record, recordHash);
    conversation.actionCertifiedRecord = record;
    conversation.recordHash = recordHash;
    runtime.recordFolds.set(recordHash, conversation);
    yield* queueLocalDurabilityVote(runtime, conversation);
  });

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
  });

export const completeActionRecord = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  certified: CertifiedRecordValue,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const canonicalCertifiedRecord = yield* encodeCanonical(
      CertifiedRecord,
      certified,
    ).pipe(Effect.mapError(blocked));
    const canonicalRecord = yield* encodeCanonical(
      ActionCertifiedRecord,
      certified.actionCertifiedRecord,
    ).pipe(Effect.mapError(blocked));
    const mutation = yield* runtime.input.store.promoteRecord({
      conversationId: conversation.conversationId,
      recordHash: certified.recordHash,
      membershipHash: conversation.membership.hash,
      anchorHash: conversation.action.anchorHash,
      canonicalRecord,
      canonicalCertifiedRecord,
      ...(conversation.action.previousRecordHash === null
        ? {}
        : {
            previousRecordHash: conversation.action.previousRecordHash,
          }),
    });
    conversation.certifiedRecord = certified;
    const retained = runtime.conversations.get(conversation.conversationId);
    if (retained !== undefined) {
      retained.head = {
        recordHash: certified.recordHash,
        action: certified.actionCertifiedRecord.action,
        certifiedRecord: certified,
      };
    }
    if (conversation.foldKind === "start") {
      const completion = runtime.completions.get(conversation.conversationId);
      if (completion !== undefined) {
        yield* Deferred.succeed(completion, undefined);
      }
    } else {
      if (retained !== undefined) {
        retained.currentAnchor = conversation.routerAnchor;
      }
      yield* Deferred.succeed(conversation.completion, undefined);
    }
    if (mutation === "inserted" && !conversation.certifiedBroadcastQueued) {
      yield* queueOuterPacket(runtime, conversation, certified).pipe(
        Effect.mapError(blocked),
      );
      conversation.certifiedBroadcastQueued = true;
    }
    yield* SubscriptionRef.update(runtime.revision, (revision) => revision + 1);
    if (mutation === "inserted" && runtime.openFloor !== undefined) {
      const currentAnchorHash =
        conversation.foldKind === "start"
          ? conversation.currentAnchor.kind === "genesis_anchor"
            ? yield* hashAnchor(conversation.currentAnchor).pipe(
                Effect.mapError(blocked),
              )
            : conversation.currentAnchor.anchorHash
          : conversation.action.anchorHash;
      yield* runtime.openFloor
        .certifiedHead({
          conversationId: conversation.conversationId,
          membership: conversation.membership,
          currentAnchorHash,
          recordHash: certified.recordHash,
          record: certified,
        })
        .pipe(Effect.mapError(blocked));
    }
  });

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
  });

export const retainCertifiedVotes = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  certified: CertifiedRecordValue,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.forEach(
    certified.durabilityVotes,
    (representation) =>
      verifyStableEvidence({
        representation,
        membership: conversation.membership,
      }).pipe(
        Effect.mapError(blocked),
        Effect.flatMap(({ message, statement }) =>
          statement.kind === "durability_vote"
            ? persistEvidence(
                runtime,
                conversation.conversationId,
                "durability",
                certified.recordHash,
                statement.signerAgentId,
                message,
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() =>
                    conversation.durabilityVotes.set(
                      statement.signerAgentId,
                      message,
                    ),
                  ),
                ),
              )
            : Effect.fail(blocked()),
        ),
      ),
    { concurrency: 1, discard: true },
  );

/** Requeue only deterministic consequences of one recovered durable action fold. */
export const resumeActionFold = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    if (conversation.certifiedRecord !== undefined) {
      if (conversation.foldKind === "start") {
        const completion = runtime.completions.get(conversation.conversationId);
        if (completion !== undefined) {
          yield* Deferred.succeed(completion, undefined);
        }
      }
      return;
    }
    if (conversation.actionCertifiedRecord !== undefined) {
      yield* queueOuterPacket(
        runtime,
        conversation,
        conversation.actionCertifiedRecord,
      ).pipe(Effect.mapError(blocked));
      const retainedVote = conversation.durabilityVotes.get(
        runtime.input.localAgentCard.agentId,
      );
      if (retainedVote === undefined) {
        yield* queueLocalDurabilityVote(runtime, conversation);
      } else if (!conversation.durabilityVoteQueued) {
        yield* queueOuterEvidence(runtime, conversation, retainedVote).pipe(
          Effect.mapError(blocked),
        );
        conversation.durabilityVoteQueued = true;
      }
      yield* maybePromote(runtime, conversation);
      return;
    }
    const retainedSignature = conversation.actionSignatures.get(
      runtime.input.localAgentCard.agentId,
    );
    if (
      retainedSignature !== undefined &&
      !conversation.actionSignatureQueued
    ) {
      yield* queueOuterEvidence(runtime, conversation, retainedSignature).pipe(
        Effect.mapError(blocked),
      );
      conversation.actionSignatureQueued = true;
    }
  });
