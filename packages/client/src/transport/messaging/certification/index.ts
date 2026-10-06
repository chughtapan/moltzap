/**
 * @file Router-ordered proposal selection and addressed record certification.
 * Each member assembles both certified records from the evidence it receives;
 * a proposal naming a predecessor this endpoint lacks waits for catch-up.
 */

import {
  type AgentId,
  MOLTZAP_VERSION,
  type SignedMessage,
} from "@moltzap/identity";
import { Deferred, Effect } from "effect";
import type { SendError } from "../errors.js";
import {
  type ConversationFoundation,
  type EndpointStoreError,
  isSemanticStoreRejection,
  type ProposalLock,
} from "../../../store/index.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "../../router/index.js";
import {
  type ActionCertifiedRecord,
  type ActionCore,
  ActionCore as ActionCoreSchema,
  type ActionHash,
  type ActionProposal,
  type AnchorHash,
  type CertifiedRecord,
  ClientRepresentationError,
  type ConversationId,
  decodeCanonical,
  type DecodedOuterBody,
  encodeCanonical,
  equalCanonical,
  EvidenceStatement,
  GenesisAnchorBody,
  hashAnchor,
  MembershipDescriptor,
  memberCard,
  type PostActionCore,
  quorumThreshold,
  signEvidenceMessage,
  type VerifiedEvidence,
  type VerifiedMembership,
  verifyActionCertifiedRecord,
  verifyActionProposal,
  verifyCertifiedRecord,
  verifyMembershipDescriptor,
  verifyOuterMessage,
  verifyStableEvidence,
} from "../../wire/index.js";
import {
  inboundDelivery,
  makeActionCertifiedRecord,
  makeCertifiedRecord,
  protocolEvidence,
  recordAnchorHash,
  stagedRecord,
  storedCertifiedRecord,
} from "../history/index.js";
import {
  type EngineActionFold,
  type EngineConversation,
  type EnginePostIntent,
  type EngineRuntime,
  makeActionFold,
} from "../runtime/index.js";
import {
  evidenceMatchesFold,
  evidenceRoute,
  type EvidenceRoute,
  verifiedEvidenceForRoute,
} from "./evidence.js";

/** Whether verified evidence names a fold, shared with engine startup. */
export { evidenceMatchesFold, type EvidenceRoute } from "./evidence.js";

const persistenceFailure = () => new RouterWorkerPersistenceError();

const localRepresentationFailure = (): RouterWorkerPersistenceError =>
  persistenceFailure();

const currentAnchorHash = (
  conversation: EngineConversation,
): Effect.Effect<AnchorHash, RouterWorkerPersistenceError> =>
  conversation.currentAnchor.kind === "genesis_anchor_body"
    ? hashAnchor(conversation.currentAnchor).pipe(
        Effect.mapError(localRepresentationFailure),
      )
    : Effect.succeed(conversation.currentAnchor.anchorHash);

const gapFree = (
  conversation: EngineConversation,
  action: ActionCore,
): Effect.Effect<boolean, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    if (action.kind === "GENESIS") {
      return (
        conversation.head === undefined &&
        conversation.currentAnchor.kind === "genesis_anchor_body" &&
        (yield* equalCanonical(
          GenesisAnchorBody,
          conversation.currentAnchor,
          action.anchor,
        ).pipe(Effect.mapError(localRepresentationFailure)))
      );
    }
    return (
      conversation.head?.recordHash === action.previousRecordHash &&
      (yield* currentAnchorHash(conversation)) === action.anchorHash
    );
  });

const conversationForAction = (
  runtime: EngineRuntime,
  action: ActionCore,
  routerInstanceId: RouterWorkerIngress<DecodedOuterBody>["routerInstanceId"],
): Effect.Effect<EngineConversation | undefined, ClientRepresentationError> =>
  Effect.gen(function* () {
    const retained = runtime.conversations.get(action.conversationId);
    if (action.kind === "POST") {
      return retained;
    }
    if (retained !== undefined) {
      return retained;
    }
    const membership = yield* verifyMembershipDescriptor(
      action.membership,
      runtime.input.registrySignerPublicKey,
    );
    if (action.anchor.routerInstanceId !== routerInstanceId) {
      return undefined;
    }
    return {
      conversationId: action.conversationId,
      membership,
      currentAnchor: action.anchor,
    };
  });

const genesisFoundation = (
  conversation: EngineConversation,
  action: Extract<ActionCore, { readonly kind: "GENESIS" }>,
): Effect.Effect<ConversationFoundation, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    return {
      conversationId: action.conversationId,
      membershipHash: conversation.membership.hash,
      canonicalMembership: yield* encodeCanonical(
        MembershipDescriptor,
        conversation.membership.descriptor,
      ).pipe(Effect.mapError(localRepresentationFailure)),
      anchorHash: yield* hashAnchor(action.anchor).pipe(
        Effect.mapError(localRepresentationFailure),
      ),
      canonicalAnchor: yield* encodeCanonical(
        GenesisAnchorBody,
        action.anchor,
      ).pipe(Effect.mapError(localRepresentationFailure)),
    };
  });

const proposalLock = (
  conversation: EngineConversation,
  action: ActionCore,
  actionHash: ActionHash,
): Effect.Effect<ProposalLock, RouterWorkerPersistenceError> =>
  encodeCanonical(ActionCoreSchema, action).pipe(
    Effect.mapError(localRepresentationFailure),
    Effect.map((canonicalActionCore) => ({
      conversationId: conversation.conversationId,
      ...(action.previousRecordHash === null
        ? {}
        : { previousRecordHash: action.previousRecordHash }),
      actionHash,
      canonicalActionCore,
    })),
  );

const lockAction = (
  runtime: EngineRuntime,
  conversation: EngineConversation,
  action: ActionCore,
  actionHash: ActionHash,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const lock = yield* proposalLock(conversation, action, actionHash);
    if (
      action.kind === "GENESIS" &&
      !runtime.conversations.has(action.conversationId)
    ) {
      const foundation = yield* genesisFoundation(conversation, action);
      yield* runtime.input.store.lockGenesisProposal(foundation, lock);
      yield* Effect.sync(() => {
        runtime.conversations.set(action.conversationId, conversation);
      });
      return;
    }
    yield* runtime.input.store.lockProposal(lock);
  });

const foldFor = (
  runtime: EngineRuntime,
  conversation: EngineConversation,
  action: ActionCore,
  actionHash: ActionHash,
): EngineActionFold => {
  const retained = runtime.actionFolds.get(actionHash);
  if (retained !== undefined) {
    return retained;
  }
  const fold = makeActionFold(
    conversation,
    action,
    actionHash,
    action.kind === "GENESIS" ? action.anchor : conversation.currentAnchor,
  );
  runtime.actionFolds.set(actionHash, fold);
  return fold;
};

const mergeEvidence = (
  runtime: EngineRuntime,
  fold: EngineActionFold,
  kind: "action" | "durability",
  message: SignedMessage,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const subjectId = kind === "action" ? fold.actionHash : fold.recordHash;
    if (subjectId === undefined) {
      return;
    }
    const row = yield* protocolEvidence(
      fold.conversation.conversationId,
      kind,
      subjectId,
      message,
    ).pipe(Effect.mapError(localRepresentationFailure));
    yield* runtime.input.store.mergeEvidence(row);
    const evidence =
      kind === "action" ? fold.actionEvidence : fold.durabilityEvidence;
    yield* Effect.sync(() => {
      evidence.set(message.senderAgentId, message);
    });
  });

const localActionEvidence = (
  runtime: EngineRuntime,
  fold: EngineActionFold,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const localAgentId = runtime.input.localAgentCard.agentId;
    if (fold.localActionEvidenceQueued) {
      return;
    }
    const retained = fold.actionEvidence.has(localAgentId);
    const evidence = yield* selectLocalActionEvidence(runtime, fold);
    if (evidence === undefined) {
      return;
    }
    if (!retained) {
      yield* mergeEvidence(runtime, fold, "action", evidence);
    }
    yield* Effect.uninterruptible(
      runtime.outbox.queueEvidence(fold.conversation, evidence).pipe(
        Effect.mapError(() => persistenceFailure()),
        Effect.zipRight(
          Effect.sync(() => {
            fold.localActionEvidenceQueued = true;
          }),
        ),
      ),
    );
  });

function selectLocalActionEvidence(
  runtime: EngineRuntime,
  fold: EngineActionFold,
): Effect.Effect<SignedMessage | undefined, RouterWorkerPersistenceError> {
  const retained = fold.actionEvidence.get(
    runtime.input.localAgentCard.agentId,
  );
  if (retained !== undefined) {
    return Effect.succeed(retained);
  }
  return runtime.input
    .actionPolicy({
      action: fold.action,
      membership: fold.conversation.membership,
    })
    .pipe(
      Effect.flatMap((policyDecision) => {
        switch (policyDecision) {
          case "sign":
            return signLocalActionEvidence(runtime, fold);
          case "refuse":
            return Effect.succeed(undefined);
          default: {
            const exhaustive: never = policyDecision;
            return exhaustive;
          }
        }
      }),
    );
}

function signLocalActionEvidence(
  runtime: EngineRuntime,
  fold: EngineActionFold,
): Effect.Effect<SignedMessage, RouterWorkerPersistenceError> {
  return signEvidenceMessage({
    statement: {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_signature",
      signerAgentId: runtime.input.localAgentCard.agentId,
      actionHash: fold.actionHash,
    },
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(Effect.mapError(localRepresentationFailure));
}

const hasActionThreshold = (fold: EngineActionFold): boolean => {
  const memberCount = fold.conversation.membership.members.length;
  const count = fold.actionEvidence.size;
  const thresholdReached =
    fold.action.kind === "GENESIS"
      ? count === memberCount
      : count >= quorumThreshold(memberCount);
  return (
    thresholdReached &&
    fold.actionEvidence.has(fold.action.postIntent.authorAgentId)
  );
};

const hasDurabilityThreshold = (fold: EngineActionFold): boolean =>
  fold.durabilityEvidence.size >=
  quorumThreshold(fold.conversation.membership.members.length);

const actionAnchorHash = (
  fold: EngineActionFold,
): Effect.Effect<AnchorHash, RouterWorkerPersistenceError> =>
  recordAnchorHash(fold).pipe(Effect.mapError(localRepresentationFailure));

const localDurabilityEvidence = (
  runtime: EngineRuntime,
  fold: EngineActionFold,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const recordHash = fold.recordHash;
    const localAgentId = runtime.input.localAgentCard.agentId;
    if (recordHash === undefined || fold.localDurabilityEvidenceQueued) {
      return;
    }
    const retained = fold.durabilityEvidence.get(localAgentId);
    const evidence =
      retained ??
      (yield* signEvidenceMessage({
        statement: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "durability_vote",
          signerAgentId: localAgentId,
          conversationId: fold.conversation.conversationId,
          membershipHash: fold.conversation.membership.hash,
          recordHash,
        },
        agentCard: runtime.input.localAgentCard,
        signingAuthority: runtime.input.signingAuthority,
      }).pipe(Effect.mapError(localRepresentationFailure)));
    if (retained === undefined) {
      yield* mergeEvidence(runtime, fold, "durability", evidence);
    }
    yield* Effect.uninterruptible(
      runtime.outbox.queueEvidence(fold.conversation, evidence).pipe(
        Effect.mapError(() => persistenceFailure()),
        Effect.zipRight(
          Effect.sync(() => {
            fold.localDurabilityEvidenceQueued = true;
          }),
        ),
      ),
    );
  });

const applyPromotionState = (
  runtime: EngineRuntime,
  fold: EngineActionFold,
  record: CertifiedRecord,
) =>
  Effect.sync(() => {
    fold.certifiedRecord = record;
    fold.conversation.head = {
      recordHash: record.actionCertifiedRecord.recordHash,
      record,
    };
    runtime.completedPosts.set(
      fold.action.postIntent.postId,
      record.actionCertifiedRecord.recordHash,
    );
    return fold.action.postIntent.authorAgentId ===
      runtime.input.localAgentCard.agentId
      ? runtime.intents.get(fold.action.postIntent.postId)
      : undefined;
  });

function completePromotion(
  runtime: EngineRuntime,
  fold: EngineActionFold,
  record: CertifiedRecord,
): Effect.Effect<void> {
  return applyPromotionState(runtime, fold, record).pipe(
    Effect.flatMap((intent) =>
      intent === undefined
        ? Effect.void
        : Deferred.succeed(
            intent.completion,
            record.actionCertifiedRecord.recordHash,
          ).pipe(Effect.asVoid),
    ),
  );
}

type ReproposalDisposition = "fail" | "ignore";

const reproposalDispositionByReason = {
  "idempotency-conflict": "fail",
  "outcome-unknown": "fail",
  "certification-unavailable": "ignore",
  "content-invalid": "fail",
  "invalid-address": "fail",
  "membership-invalid": "fail",
  "network-unavailable": "ignore",
  "not-registered": "fail",
  "persistence-failed": "fail",
  "unknown-agent": "fail",
  "version-mismatch": "fail",
} as const satisfies Readonly<
  Record<SendError["reason"], ReproposalDisposition>
>;

const reproposePendingIntent = (
  runtime: EngineRuntime,
  pending: EnginePostIntent,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  runtime.phases.proposeIntent(runtime, pending).pipe(
    Effect.asVoid,
    Effect.catchTag("SendError", (error) =>
      reproposalDispositionByReason[error.reason] === "ignore"
        ? Effect.void
        : Effect.fail(persistenceFailure()),
    ),
  );

const rebasePendingIntents = (
  runtime: EngineRuntime,
  conversationId: EngineConversation["conversationId"],
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.forEach(
    runtime.intents.values(),
    (pending) =>
      pending.intent.conversationId === conversationId &&
      !runtime.completedPosts.has(pending.intent.postId)
        ? reproposePendingIntent(runtime, pending)
        : Effect.void,
    { concurrency: 1, discard: true },
  );

/**
 * How a certified record reached this endpoint: a catch-up page, which stages
 * and promotes it in one step, or Router-ordered certification, which
 * promotes a record already staged here, whether assembled locally or
 * received whole.
 */
type RecordSource = "catch-up" | "ordered";

function persistPromotionWithoutDelivery(
  runtime: EngineRuntime,
  record: Effect.Effect.Success<ReturnType<typeof storedCertifiedRecord>>,
  source: RecordSource,
) {
  switch (source) {
    case "catch-up":
      return runtime.input.store.applyCatchUpRecord(record);
    case "ordered":
      return runtime.input.store.promoteRecord(record);
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function persistPromotionWithDelivery(
  runtime: EngineRuntime,
  record: Effect.Effect.Success<ReturnType<typeof storedCertifiedRecord>>,
  source: RecordSource,
  delivery: Effect.Effect.Success<ReturnType<typeof inboundDelivery>>,
) {
  switch (source) {
    case "catch-up":
      return runtime.input.store.applyCatchUpRecord(record, delivery);
    case "ordered":
      return runtime.input.store.promoteRecord(record, delivery);
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

const promote = (
  runtime: EngineRuntime,
  fold: EngineActionFold,
  record: CertifiedRecord,
  source: RecordSource,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const stored = yield* storedCertifiedRecord(record, fold).pipe(
      Effect.mapError(localRepresentationFailure),
    );
    const remote =
      fold.action.postIntent.authorAgentId !==
      runtime.input.localAgentCard.agentId;
    const delivery = remote
      ? yield* inboundDelivery(
          fold.conversation,
          record,
          runtime.input.localAgentCard.agentId,
        ).pipe(Effect.mapError(localRepresentationFailure))
      : undefined;
    yield* delivery === undefined
      ? persistPromotionWithoutDelivery(runtime, stored, source)
      : persistPromotionWithDelivery(runtime, stored, source, delivery);
    yield* Effect.uninterruptible(completePromotion(runtime, fold, record));
    yield* rebasePendingIntents(runtime, fold.conversation.conversationId);
    yield* acceptWaitingProposal(runtime, fold.conversation);
  });

const maybePromote = (
  runtime: EngineRuntime,
  fold: EngineActionFold,
  actionCertifiedRecord: ActionCertifiedRecord,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    if (!hasDurabilityThreshold(fold) || fold.certifiedRecord !== undefined) {
      return;
    }
    const record = yield* makeCertifiedRecord(actionCertifiedRecord, fold).pipe(
      Effect.mapError(localRepresentationFailure),
    );
    yield* verifyCertifiedRecord({
      record,
      registrySignerPublicKey: runtime.input.registrySignerPublicKey,
    }).pipe(Effect.mapError(localRepresentationFailure));
    yield* promote(runtime, fold, record, "ordered");
  });

const stageActionCertificate = (
  runtime: EngineRuntime,
  fold: EngineActionFold,
  record: ActionCertifiedRecord,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const stored = yield* stagedRecord(record).pipe(
      Effect.mapError(localRepresentationFailure),
    );
    yield* runtime.input.store.stageRecord(stored);
    yield* Effect.sync(() => {
      fold.recordHash = record.recordHash;
      runtime.recordFolds.set(record.recordHash, fold);
    });
    yield* localDurabilityEvidence(runtime, fold);
    yield* maybePromote(runtime, fold, record);
  });

const maybeCertifyAction = (
  runtime: EngineRuntime,
  fold: EngineActionFold,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    if (!hasActionThreshold(fold) || fold.recordHash !== undefined) {
      return;
    }
    const record = yield* makeActionCertifiedRecord(
      fold,
      yield* actionAnchorHash(fold),
    ).pipe(Effect.mapError(localRepresentationFailure));
    yield* stageActionCertificate(runtime, fold, record);
  });

type ProtocolAcceptanceError =
  | ClientRepresentationError
  | EndpointStoreError
  | RouterWorkerPersistenceError;

const prepareProposalFold = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  proposal: ActionProposal,
): Effect.Effect<EngineActionFold | undefined, ProtocolAcceptanceError> =>
  Effect.gen(function* () {
    const conversation = yield* conversationForAction(
      runtime,
      proposal.action,
      ingress.routerInstanceId,
    );
    if (conversation === undefined) {
      return undefined;
    }
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: conversation.membership,
    });
    const verified = yield* verifyActionProposal({
      proposal,
      membership: conversation.membership,
      outerSenderAgentId: ingress.message.senderAgentId,
    });
    if (!(yield* gapFree(conversation, proposal.action))) {
      yield* awaitPredecessor(
        runtime,
        conversation,
        ingress,
        proposal.action,
        verified.actionHash,
      );
      return undefined;
    }
    yield* lockAction(
      runtime,
      conversation,
      proposal.action,
      verified.actionHash,
    );
    return foldFor(runtime, conversation, proposal.action, verified.actionHash);
  });

const acceptProposal = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  proposal: ActionProposal,
): Effect.Effect<RouterIngressDisposition, ProtocolAcceptanceError> =>
  Effect.gen(function* () {
    const fold = yield* prepareProposalFold(runtime, ingress, proposal);
    if (fold === undefined) {
      return "ignored";
    }
    yield* localActionEvidence(runtime, fold);
    yield* maybeCertifyAction(runtime, fold);
    return "accepted";
  });

const acceptEvidence = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessage,
): Effect.Effect<RouterIngressDisposition, ProtocolAcceptanceError> =>
  Effect.gen(function* () {
    const route = yield* evidenceRoute(runtime, message);
    if (route === undefined) {
      return yield* holdWaitingSignature(runtime, ingress, message);
    }
    const evidence = yield* verifiedEvidenceForRoute(ingress, message, route);
    if (!evidenceMatchesFold(route, evidence.statement)) {
      return "ignored";
    }
    yield* mergeEvidence(runtime, route.fold, route.kind, evidence.message);
    yield* advanceEvidenceFold(runtime, route);
    return "accepted";
  });

function advanceEvidenceFold(
  runtime: EngineRuntime,
  route: EvidenceRoute,
): Effect.Effect<void, ProtocolAcceptanceError> {
  switch (route.kind) {
    case "action":
      return maybeCertifyAction(runtime, route.fold);
    case "durability":
      return advanceDurabilityFold(runtime, route.fold);
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}

function advanceDurabilityFold(
  runtime: EngineRuntime,
  fold: EngineActionFold,
): Effect.Effect<void, ProtocolAcceptanceError> {
  const recordHash = fold.recordHash;
  if (recordHash === undefined) {
    return Effect.void;
  }
  const record = runtime.recordFolds.get(recordHash);
  if (record === undefined || !hasDurabilityThreshold(record)) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const actionCertifiedRecord = yield* makeActionCertifiedRecord(
      record,
      yield* actionAnchorHash(record),
    ).pipe(Effect.mapError(localRepresentationFailure));
    yield* maybePromote(runtime, record, actionCertifiedRecord);
  });
}

const membershipForRecord = (
  runtime: EngineRuntime,
  record: ActionCertifiedRecord,
): Effect.Effect<VerifiedMembership, ClientRepresentationError> =>
  verifyActionCertifiedRecord({
    record,
    registrySignerPublicKey: runtime.input.registrySignerPublicKey,
  }).pipe(Effect.map((verified) => verified.membership));

const ensureConversation = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  record: ActionCertifiedRecord,
): EngineConversation | undefined => {
  const action = record.recordCore.action;
  const retained = runtime.conversations.get(action.conversationId);
  if (retained !== undefined) {
    return retained.membership.hash === membership.hash ? retained : undefined;
  }
  if (
    action.kind !== "GENESIS" ||
    record.routerAnchor.kind !== "genesis_anchor_body"
  ) {
    return undefined;
  }
  return {
    conversationId: action.conversationId,
    membership,
    currentAnchor: record.routerAnchor,
  };
};

const certificateEvidenceMatches = (
  fold: EngineActionFold,
  kind: "action" | "durability",
  evidence: VerifiedEvidence,
): boolean =>
  evidenceMatchesFold(
    kind === "action" ? { fold, kind: "action" } : { fold, kind: "durability" },
    evidence.statement,
  );

const mergeCertificateEvidence = (
  runtime: EngineRuntime,
  fold: EngineActionFold,
  kind: "action" | "durability",
  representations: readonly unknown[],
): Effect.Effect<void, ProtocolAcceptanceError> =>
  Effect.forEach(
    representations,
    (representation) =>
      verifyStableEvidence({
        representation,
        membership: fold.conversation.membership,
      }).pipe(
        Effect.filterOrFail(
          (evidence) => certificateEvidenceMatches(fold, kind, evidence),
          () => new ClientRepresentationError(),
        ),
        Effect.flatMap((evidence) =>
          mergeEvidence(runtime, fold, kind, evidence.message),
        ),
      ),
    { concurrency: 1, discard: true },
  );

const prepareRecordFold = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  membership: VerifiedMembership,
  record: ActionCertifiedRecord,
): Effect.Effect<EngineActionFold | undefined, ProtocolAcceptanceError> =>
  Effect.gen(function* () {
    yield* verifyOuterMessage({
      message: ingress.message,
      membership,
    });
    const conversation = ensureConversation(runtime, membership, record);
    const action = record.recordCore.action;
    if (conversation === undefined || !(yield* gapFree(conversation, action))) {
      return undefined;
    }
    yield* lockAction(
      runtime,
      conversation,
      action,
      record.recordCore.actionHash,
    );
    const fold = foldFor(
      runtime,
      conversation,
      action,
      record.recordCore.actionHash,
    );
    yield* mergeCertificateEvidence(
      runtime,
      fold,
      "action",
      record.actionCertificate.signatures,
    );
    return fold;
  });

const acceptActionCertifiedRecord = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  record: ActionCertifiedRecord,
): Effect.Effect<RouterIngressDisposition, ProtocolAcceptanceError> =>
  Effect.gen(function* () {
    const membership = yield* membershipForRecord(runtime, record);
    const fold = yield* prepareRecordFold(runtime, ingress, membership, record);
    if (fold === undefined) {
      return "ignored";
    }
    yield* stageActionCertificate(runtime, fold, record);
    return "accepted";
  });

const acceptCertifiedRecord = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  record: CertifiedRecord,
  applyCatchUp = false,
): Effect.Effect<RouterIngressDisposition, ProtocolAcceptanceError> =>
  Effect.gen(function* () {
    const membership = yield* verifyCertifiedRecord({
      record,
      registrySignerPublicKey: runtime.input.registrySignerPublicKey,
    });
    const actionRecord = record.actionCertifiedRecord;
    const fold = yield* prepareRecordFold(
      runtime,
      ingress,
      membership,
      actionRecord,
    );
    if (fold === undefined) {
      return "ignored";
    }
    yield* runtime.input.store.stageRecord(yield* stagedRecord(actionRecord));
    yield* Effect.sync(() => {
      fold.recordHash = actionRecord.recordHash;
      runtime.recordFolds.set(actionRecord.recordHash, fold);
    });
    yield* mergeCertificateEvidence(
      runtime,
      fold,
      "durability",
      record.durabilityCertificate.votes,
    );
    yield* promote(
      runtime,
      fold,
      record,
      applyCatchUp ? "catch-up" : "ordered",
    );
    return "accepted";
  });

const acceptDirectPacket = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, ProtocolAcceptanceError> => {
  if (ingress.payload.kind !== "direct") {
    return acceptEvidence(runtime, ingress, ingress.payload.message);
  }
  return acceptPacket(runtime, ingress, ingress.payload.packet);
};

function acceptPacket(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: Extract<DecodedOuterBody, { readonly kind: "direct" }>["packet"],
): Effect.Effect<RouterIngressDisposition, ProtocolAcceptanceError> {
  switch (packet.kind) {
    case "action_proposal":
      return acceptProposal(runtime, ingress, packet);
    case "action_certified_record":
      return acceptActionCertifiedRecord(runtime, ingress, packet);
    case "certified_record":
      return acceptCertifiedRecord(runtime, ingress, packet);
    case "catch_up_request":
    case "catch_up_page":
    case "catch_up_incomplete":
    case "completed_reanchor":
      return Effect.succeed("ignored");
    default: {
      const exhaustive: never = packet;
      return exhaustive;
    }
  }
}

const ignoredDisposition: RouterIngressDisposition = "ignored";

/**
 * A verified POST proposal naming a position this endpoint does not hold yet,
 * with the action signatures members send for it while catch-up runs. They
 * are not sent again, and the proposal may need them to reach its threshold
 * here. One signature ingress per member, the latest, is kept.
 */
interface WaitingProposal {
  readonly conversation: EngineConversation;
  readonly action: PostActionCore;
  readonly actionHash: ActionHash;
  readonly proposal: RouterWorkerIngress<DecodedOuterBody>;
  readonly signatures: Map<AgentId, RouterWorkerIngress<DecodedOuterBody>>;
}

/** At most one waiting proposal per conversation, for each engine. */
const waitingProposals = new WeakMap<
  EngineRuntime,
  Map<ConversationId, WaitingProposal>
>();

function waitingFor(
  runtime: EngineRuntime,
): Map<ConversationId, WaitingProposal> {
  const retained = waitingProposals.get(runtime);
  if (retained !== undefined) {
    return retained;
  }
  const created = new Map<ConversationId, WaitingProposal>();
  waitingProposals.set(runtime, created);
  return created;
}

/**
 * Hold a verified POST proposal whose predecessor or anchor this endpoint does
 * not hold, and ask the members for the history after its durable position.
 * The first proposal naming a position is kept: every member that held the
 * predecessor saw the same Router order and locked that one. A proposal naming
 * another position replaces it and asks again. A GENESIS that does not fit,
 * and a POST naming a record certified here before the current head, are only
 * ignored: the second is a proposal its author sent before it saw the head
 * certified, and the author proposes again from the head.
 * @param runtime Engine whose conversation lacks the named position.
 * @param conversation Retained conversation the proposal extends.
 * @param ingress Verified Router delivery carrying the proposal.
 * @param action The proposal's action.
 * @param actionHash Hash of `action`, which its signatures name.
 * @returns Completion once the proposal is held and catch-up is requested.
 */
function awaitPredecessor(
  runtime: EngineRuntime,
  conversation: EngineConversation,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  action: ActionCore,
  actionHash: ActionHash,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  if (
    action.kind !== "POST" ||
    namesPassedRecord(runtime, conversation, action)
  ) {
    return Effect.void;
  }
  const waiting = waitingFor(runtime);
  const held = waiting.get(conversation.conversationId);
  if (
    held?.action.previousRecordHash === action.previousRecordHash &&
    held.action.anchorHash === action.anchorHash
  ) {
    return Effect.void;
  }
  return Effect.sync(() => {
    waiting.set(conversation.conversationId, {
      conversation,
      action,
      actionHash,
      proposal: ingress,
      signatures: new Map(),
    });
  }).pipe(
    Effect.zipRight(
      runtime.phases.requestCatchUp(runtime, conversation.conversationId),
    ),
  );
}

function namesPassedRecord(
  runtime: EngineRuntime,
  conversation: EngineConversation,
  action: PostActionCore,
): boolean {
  return (
    action.previousRecordHash !== conversation.head?.recordHash &&
    runtime.recordFolds.get(action.previousRecordHash)?.certifiedRecord !==
      undefined
  );
}

/**
 * Hold an action signature that names no fold when it signs a waiting
 * proposal and a member sent it. Every other evidence without a fold is
 * ignored.
 * @param runtime Engine whose waiting proposals may take the signature.
 * @param ingress Router delivery carrying the evidence.
 * @param message Stable inner evidence message.
 * @returns `ignored`: a held signature changes no durable state until replayed.
 */
function holdWaitingSignature(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessage,
): Effect.Effect<RouterIngressDisposition, ClientRepresentationError> {
  return decodeCanonical(EvidenceStatement, message.body).pipe(
    Effect.flatMap((statement) =>
      Effect.sync(() => {
        if (statement.kind !== "action_signature") {
          return;
        }
        const senderAgentId = ingress.message.senderAgentId;
        for (const waiting of waitingFor(runtime).values()) {
          if (
            waiting.actionHash === statement.actionHash &&
            memberCard(waiting.conversation.membership, senderAgentId) !==
              undefined
          ) {
            waiting.signatures.set(senderAgentId, ingress);
          }
        }
      }),
    ),
    Effect.as(ignoredDisposition),
  );
}

/**
 * Accept the proposal waiting in a conversation once the conversation holds
 * the position it names, then its held signatures. Held input that
 * fails verification or that the store refuses is ignored, as it would have
 * been on arrival.
 * @param runtime Engine whose conversation just advanced.
 * @param conversation Conversation whose waiting proposal may now fit.
 * @returns Completion once the waiting proposal is accepted or still waits.
 */
function acceptWaitingProposal(
  runtime: EngineRuntime,
  conversation: EngineConversation,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> {
  const waiting = waitingFor(runtime);
  const held = waiting.get(conversation.conversationId);
  if (held === undefined) {
    return Effect.void;
  }
  return gapFree(conversation, held.action).pipe(
    Effect.flatMap((ready) =>
      ready
        ? Effect.sync(() => {
            waiting.delete(conversation.conversationId);
          }).pipe(
            Effect.zipRight(
              Effect.forEach(
                [held.proposal, ...held.signatures.values()],
                (ingress) => acceptHeldIngress(runtime, ingress),
                { concurrency: 1, discard: true },
              ),
            ),
          )
        : Effect.void,
    ),
  );
}

function acceptHeldIngress(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> {
  return acceptDirectPacket(runtime, ingress).pipe(
    Effect.asVoid,
    Effect.catchTag("ClientRepresentationError", () => Effect.void),
    Effect.catchTag("EndpointStoreError", (error) =>
      isSemanticStoreRejection(error) ? Effect.void : Effect.fail(error),
    ),
  );
}

/**
 * Forget every waiting proposal and its held evidence, as a Router
 * discontinuity does: the recovery run that follows ignores action traffic.
 * @param runtime Engine whose waiting proposals are dropped.
 */
export function forgetWaitingProposals(runtime: EngineRuntime): void {
  waitingProposals.delete(runtime);
}

/**
 * Apply one semantically verified Router-ordered protocol value.
 * @param runtime Current engine state and durable protocol dependencies.
 * @param ingress Authenticated Router-ordered protocol input.
 * @returns Whether the input changed durable state or was irrelevant.
 */
export const acceptEngineIngress = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  runtime.gate
    .withPermits(1)(acceptDirectPacket(runtime, ingress))
    .pipe(
      Effect.catchTag("ClientRepresentationError", () =>
        Effect.succeed(ignoredDisposition),
      ),
      Effect.catchTag("EndpointStoreError", (error) =>
        isSemanticStoreRejection(error)
          ? Effect.succeed(ignoredDisposition)
          : Effect.fail(persistenceFailure()),
      ),
      Effect.withSpan("acceptEngineIngress"),
    );

/**
 * Apply a complete certified record from catch-up, during a recovery run or
 * outside one, through the same durable path as Router-ordered certification.
 * @param runtime Current engine state and durable protocol dependencies.
 * @param ingress Authenticated catch-up input from one fixed member.
 * @returns Whether catch-up advanced durable state or ignored the input.
 */
export const acceptEngineRecoveryIngress = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  runtime.gate
    .withPermits(1)(
      ingress.payload.kind === "direct" &&
        ingress.payload.packet.kind === "certified_record"
        ? acceptCertifiedRecord(runtime, ingress, ingress.payload.packet, true)
        : Effect.succeed(ignoredDisposition),
    )
    .pipe(
      Effect.catchTag("ClientRepresentationError", () =>
        Effect.succeed(ignoredDisposition),
      ),
      Effect.catchTag("EndpointStoreError", (error) =>
        isSemanticStoreRejection(error)
          ? Effect.succeed(ignoredDisposition)
          : Effect.fail(persistenceFailure()),
      ),
      Effect.withSpan("acceptEngineRecoveryIngress"),
    );

/**
 * Resume only the evidence obligations already selected in durable state.
 * @param runtime Recovered engine state and durable protocol dependencies.
 * @returns Completion after all resumable evidence work has been queued.
 */
export const resumeEngineFolds = (
  runtime: EngineRuntime,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  runtime.gate
    .withPermits(1)(
      Effect.forEach(
        runtime.actionFolds.values(),
        (fold) =>
          Effect.gen(function* () {
            yield* localActionEvidence(runtime, fold);
            yield* maybeCertifyAction(runtime, fold);
            if (fold.recordHash !== undefined) {
              yield* localDurabilityEvidence(runtime, fold);
              const record = yield* makeActionCertifiedRecord(
                fold,
                yield* actionAnchorHash(fold),
              ).pipe(Effect.mapError(localRepresentationFailure));
              yield* maybePromote(runtime, fold, record);
            }
          }),
        { concurrency: 1, discard: true },
      ),
    )
    .pipe(
      Effect.catchTag("EndpointStoreError", () =>
        Effect.fail(persistenceFailure()),
      ),
      Effect.withSpan("resumeEngineFolds"),
    );
