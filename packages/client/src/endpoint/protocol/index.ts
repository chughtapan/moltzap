/** @file Router-ordered proposal selection and addressed record certification. */

import { MOLTZAP_VERSION, type SignedMessage } from "@moltzap/identity";
import { Deferred, Effect, type Schema, SubscriptionRef } from "effect";
import type { SendError } from "../../contract.js";
import type {
  EngineActionFold,
  EngineConversation,
  EnginePostIntent,
  EngineRuntime,
} from "../engine-types.js";
import type {
  ConversationFoundation,
  EndpointStoreError,
  ProposalLock,
} from "../store.js";
import {
  inboundDelivery,
  makeActionCertifiedRecord,
  makeCertifiedRecord,
  protocolEvidence,
  recordAnchorHash,
  stagedRecord,
  storedCertifiedRecord,
} from "../engine-durability.js";
import {
  proposeIntent,
  queueCertifiedPacket,
  queueEvidence,
} from "../engine-send.js";
import {
  type ActionCertifiedRecord,
  type ActionCore,
  ActionCore as ActionCoreSchema,
  type ActionHash,
  type ActionProposal,
  type AnchorHash,
  type CertifiedRecord,
  ClientRepresentationError,
  type DecodedOuterBody,
  encodeCanonical,
  GenesisAnchorBody,
  hashAnchor,
  MembershipDescriptor,
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
} from "../representation.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "../router-worker/index.js";
import {
  evidenceMatchesFold,
  evidenceRoute,
  type EvidenceRoute,
  verifiedEvidenceForRoute,
} from "./evidence.js";

const persistenceFailure = () => new RouterWorkerPersistenceError();

const isSemanticStoreRejection = (error: EndpointStoreError): boolean =>
  error.reason === "conflict" || error.reason === "invalid-input";

const localRepresentationFailure = (): RouterWorkerPersistenceError =>
  persistenceFailure();

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((byte, index) => byte === right[index]);

const sameCanonical = <Value, Encoded, Requirements>(
  schema: Schema.Schema<Value, Encoded, Requirements>,
  left: Value,
  right: Value,
) =>
  Effect.all([
    encodeCanonical(schema, left),
    encodeCanonical(schema, right),
  ]).pipe(
    Effect.map(([leftBytes, rightBytes]) => sameBytes(leftBytes, rightBytes)),
  );

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
        (yield* sameCanonical(
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
  const fold: EngineActionFold = {
    conversation,
    action,
    actionHash,
    routerAnchor:
      action.kind === "GENESIS" ? action.anchor : conversation.currentAnchor,
    actionEvidence: new Map(),
    durabilityEvidence: new Map(),
    localActionEvidenceQueued: false,
    actionCertifiedRecordQueued: false,
    localDurabilityEvidenceQueued: false,
    certifiedRecordQueued: false,
  };
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
      queueEvidence(runtime, fold.conversation, evidence).pipe(
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
      queueEvidence(runtime, fold.conversation, evidence).pipe(
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
    runtime.completedPostIds.add(fold.action.postIntent.postId);
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
        : Deferred.succeed(intent.completion, undefined).pipe(Effect.asVoid),
    ),
  );
}

type ReproposalDisposition = "fail" | "ignore";

const reproposalDispositionByReason = {
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
  proposeIntent(runtime, pending).pipe(
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
      !runtime.completedPostIds.has(pending.intent.postId)
        ? reproposePendingIntent(runtime, pending)
        : Effect.void,
    { concurrency: 1, discard: true },
  );

type RecordSource = "assembled" | "catch-up" | "received";

function persistPromotionWithoutDelivery(
  runtime: EngineRuntime,
  record: Effect.Effect.Success<ReturnType<typeof storedCertifiedRecord>>,
  source: RecordSource,
) {
  switch (source) {
    case "assembled":
      return runtime.input.store.promoteRecordForDissemination(record);
    case "catch-up":
      return runtime.input.store.applyCatchUpRecord(record);
    case "received":
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
    case "assembled":
      return runtime.input.store.promoteRecordForDissemination(
        record,
        delivery,
      );
    case "catch-up":
      return runtime.input.store.applyCatchUpRecord(record, delivery);
    case "received":
      return runtime.input.store.promoteRecord(record, delivery);
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function markCertifiedPacketQueued(
  fold: EngineActionFold,
): Effect.Effect<void> {
  return Effect.sync(() => {
    fold.certifiedRecordQueued = true;
  });
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
    const queuePromotion =
      source === "assembled"
        ? queueCertifiedPacket(runtime, fold.conversation, record).pipe(
            Effect.mapError(() => persistenceFailure()),
            Effect.zipRight(markCertifiedPacketQueued(fold)),
          )
        : Effect.sync(() => {
            fold.actionCertifiedRecordQueued = true;
            fold.certifiedRecordQueued = true;
          });
    yield* Effect.uninterruptible(
      queuePromotion.pipe(
        Effect.zipRight(completePromotion(runtime, fold, record)),
      ),
    );
    yield* SubscriptionRef.update(runtime.revision, (revision) => revision + 1);
    yield* rebasePendingIntents(runtime, fold.conversation.conversationId);
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
    yield* promote(runtime, fold, record, "assembled");
  });

type ActionCertificateSource = "assembled" | "received";

function persistActionCertificate(
  runtime: EngineRuntime,
  record: Effect.Effect.Success<ReturnType<typeof stagedRecord>>,
  source: ActionCertificateSource,
) {
  switch (source) {
    case "assembled":
      return runtime.input.store.stageRecordForDissemination(record);
    case "received":
      return runtime.input.store.stageRecord(record);
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

const stageActionCertificate = (
  runtime: EngineRuntime,
  fold: EngineActionFold,
  record: ActionCertifiedRecord,
  source: ActionCertificateSource,
): Effect.Effect<void, EndpointStoreError | RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const stored = yield* stagedRecord(record).pipe(
      Effect.mapError(localRepresentationFailure),
    );
    yield* persistActionCertificate(runtime, stored, source);
    const updateFold = Effect.sync(() => {
      fold.recordHash = record.recordHash;
      runtime.recordFolds.set(record.recordHash, fold);
    });
    if (source === "assembled") {
      yield* Effect.uninterruptible(
        queueCertifiedPacket(runtime, fold.conversation, record).pipe(
          Effect.mapError(() => persistenceFailure()),
          Effect.zipRight(
            Effect.sync(() => {
              fold.actionCertifiedRecordQueued = true;
            }),
          ),
          Effect.zipRight(updateFold),
        ),
      );
    } else {
      yield* Effect.sync(() => {
        fold.actionCertifiedRecordQueued = true;
      }).pipe(Effect.zipRight(updateFold));
    }
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
    yield* stageActionCertificate(runtime, fold, record, "assembled");
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
    if (
      conversation === undefined ||
      !(yield* gapFree(conversation, proposal.action))
    ) {
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
      return "ignored";
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
    yield* stageActionCertificate(runtime, fold, record, "received");
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
      applyCatchUp ? "catch-up" : "received",
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
 * Recovery accepts complete certified records through the same durable path.
 * @param runtime Current engine state and durable protocol dependencies.
 * @param ingress Authenticated recovery input from one fixed member.
 * @returns Whether recovery advanced durable state or ignored the input.
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
