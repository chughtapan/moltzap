/** @file Authenticated fixed-member one-item catch-up and recovery state. */

import {
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Deferred, Effect, Queue, Schema } from "effect";
import type { ConversationId } from "../contract.js";
import type { EngineConversation, EngineRuntime } from "./engine-types.js";
import type { EndpointRecovery } from "./store.js";
import {
  ActionCertifiedRecord,
  AnchorHash,
  type CatchUpIncomplete,
  type CatchUpPage,
  CatchUpRequest,
  type CatchUpRequest as CatchUpRequestValue,
  CertifiedRecord,
  type CertifiedRecord as CertifiedRecordValue,
  CompletedReanchor,
  type CompletedReanchor as CompletedReanchorValue,
  decodeCanonical,
  type DecodedOuterBody,
  type DirectPacket,
  encodeCanonical,
  memberCard,
  Membership,
  ReanchorBody,
  RecordHash,
  signEvidenceMessage,
  signOuterPacket,
  type VerifiedMembership,
  verifyCatchUpIncomplete,
  verifyCatchUpPage,
  verifyCertifiedRecord,
  verifyCompletedReanchor,
  verifyMembership,
  verifyOuterMessage,
} from "./representation.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
  type RouterWorkerRecovery,
  RouterWorkerRecoveryError,
} from "./router-worker.js";

const accepted: RouterIngressDisposition = "accepted";
const ignored: RouterIngressDisposition = "ignored";
const persistenceFailure = (): RouterWorkerPersistenceError =>
  new RouterWorkerPersistenceError();
const recoveryFailure = (): RouterWorkerRecoveryError =>
  new RouterWorkerRecoveryError();

/** Generation-scoped coordination shared with Router re-anchoring. */
export interface EngineRecoveryState {
  readonly recovery: RouterWorkerRecovery;
  readonly outbound: Queue.Queue<SignedMessageValue>;
  readonly completion: Deferred.Deferred<void, RouterWorkerRecoveryError>;
  readonly memberships: Map<ConversationId, VerifiedMembership>;
  readonly pendingRequests: Map<ConversationId, CatchUpRequestValue>;
  readonly incompleteResponders: Map<ConversationId, Set<string>>;
  readonly completedConversations: Set<ConversationId>;
  pendingOutbound: number;
  readonly onPositionReady: (
    conversationId: ConversationId,
  ) => Effect.Effect<void, RouterWorkerRecoveryError>;
}

const states = new WeakMap<EngineRuntime, EngineRecoveryState>();

/**
 * Install one Router recovery generation before sending protocol traffic.
 * @param runtime Endpoint runtime that owns the recovery generation.
 * @param state Recovery state to install.
 */
export const installEngineRecoveryState = (
  runtime: EngineRuntime,
  state: EngineRecoveryState,
): void => {
  states.set(runtime, state);
};

/**
 * Read the active Router recovery generation.
 * @param runtime Endpoint runtime whose recovery state is requested.
 * @returns The installed recovery state, when one is active.
 */
export const engineRecoveryState = (
  runtime: EngineRuntime,
): EngineRecoveryState | undefined => states.get(runtime);

/**
 * Remove a state only when it is still the installed generation.
 * @param runtime Endpoint runtime that owns the recovery state.
 * @param state Recovery state to remove if it is still installed.
 */
export const removeEngineRecoveryState = (
  runtime: EngineRuntime,
  state: EngineRecoveryState,
): void => {
  if (states.get(runtime) === state) {
    states.delete(runtime);
  }
};

/**
 * Resolve recovery only after every conversation and queued send are durable.
 * @param state Recovery state whose completion conditions are checked.
 * @returns An effect that resolves the completion when recovery is idle.
 */
export const completeEngineRecoveryIfIdle = (
  state: EngineRecoveryState,
): Effect.Effect<void> =>
  Effect.suspend(() =>
    state.completedConversations.size === state.memberships.size &&
    state.pendingOutbound === 0
      ? Deferred.succeed(state.completion, undefined).pipe(Effect.asVoid)
      : Effect.void,
  );

const membershipFor = (
  runtime: EngineRuntime,
  conversationId: ConversationId,
): VerifiedMembership | undefined =>
  states.get(runtime)?.memberships.get(conversationId) ??
  runtime.conversations.get(conversationId)?.membership;

const queueSignedPacket = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  packet: DirectPacket,
  recoveryOnly: boolean,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  signOuterPacket({
    packet,
    membership,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((message) => {
      const state = states.get(runtime);
      if (state !== undefined) {
        state.pendingOutbound += 1;
        return Queue.offer(state.outbound, message).pipe(Effect.asVoid);
      }
      return recoveryOnly
        ? Effect.fail(persistenceFailure())
        : Effect.sync(() => runtime.outbound.push(message));
    }),
  );

const positionFor = (
  recovery: EndpointRecovery,
  conversationId: ConversationId,
) => recovery.positions.find((item) => item.conversationId === conversationId);

const decodePosition = (
  recovery: EndpointRecovery,
  conversationId: ConversationId,
): Effect.Effect<
  Readonly<{ recordHash: RecordHash | null; anchorHash: AnchorHash | null }>,
  RouterWorkerRecoveryError
> => {
  const position = positionFor(recovery, conversationId);
  if (position?.headRecordHash === undefined) {
    return Effect.succeed({ recordHash: null, anchorHash: null });
  }
  return Effect.all({
    recordHash: Schema.decodeUnknown(RecordHash)(position.headRecordHash),
    anchorHash: Schema.decodeUnknown(AnchorHash)(position.currentAnchorHash),
  }).pipe(Effect.mapError(recoveryFailure));
};

/**
 * Send the exact durable head, using null/null before certified genesis.
 * @param runtime Endpoint runtime that sends the catch-up request.
 * @param conversationId Conversation whose durable head is requested.
 * @returns An effect that queues the signed catch-up request.
 */
export const requestCertifiedHistory = (
  runtime: EngineRuntime,
  conversationId: ConversationId,
): Effect.Effect<void, RouterWorkerRecoveryError> =>
  Effect.gen(function* () {
    const state = states.get(runtime);
    const membership = state?.memberships.get(conversationId);
    if (state === undefined || membership === undefined) {
      return yield* recoveryFailure();
    }
    const recovery = yield* runtime.input.store
      .recover()
      .pipe(Effect.mapError(recoveryFailure));
    const position = yield* decodePosition(recovery, conversationId);
    const request = yield* Schema.decodeUnknown(CatchUpRequest)({
      moltzapVersion: membership.membership.moltzapVersion,
      kind: "catch_up_request",
      conversationId,
      membershipHash: membership.hash,
      requesterAgentId: runtime.input.localAgentCard.agentId,
      knownRecordHash: position.recordHash,
      knownAnchorHash: position.anchorHash,
    }).pipe(Effect.mapError(recoveryFailure));
    state.pendingRequests.set(conversationId, request);
    state.incompleteResponders.set(conversationId, new Set());
    yield* queueSignedPacket(runtime, membership, request, true).pipe(
      Effect.mapError(recoveryFailure),
    );
  }).pipe(Effect.withSpan("requestCertifiedHistory"));

const recordsFor = (recovery: EndpointRecovery, id: ConversationId) =>
  recovery.certifiedRecords.filter((item) => item.conversationId === id);
const anchorsFor = (recovery: EndpointRecovery, id: ConversationId) =>
  recovery.anchors.filter((item) => item.conversationId === id);

type CatchUpItem = CertifiedRecordValue | CompletedReanchorValue;

interface CatchUpSuccessor {
  readonly item: CatchUpItem;
  readonly hasMore: boolean;
}

const successorRows = (
  recovery: EndpointRecovery,
  request: CatchUpRequestValue,
) => {
  if (request.knownRecordHash === null) {
    return recordsFor(recovery, request.conversationId).filter(
      (item) => item.previousRecordHash === undefined,
    );
  }
  const anchors = anchorsFor(recovery, request.conversationId).filter(
    (item) =>
      item.previousAnchorHash === request.knownAnchorHash &&
      item.selectedRecordHash === request.knownRecordHash,
  );
  const records = recordsFor(recovery, request.conversationId).filter(
    (item) =>
      item.previousRecordHash === request.knownRecordHash &&
      item.anchorHash === request.knownAnchorHash,
  );
  return [...anchors, ...records];
};

const nextRequest = (
  request: CatchUpRequestValue,
  item: CatchUpItem,
): CatchUpRequestValue =>
  item.kind === "completed_reanchor"
    ? { ...request, knownAnchorHash: item.anchorHash }
    : {
        ...request,
        knownRecordHash: item.recordHash,
        knownAnchorHash: item.actionCertifiedRecord.anchorHash,
      };

const decodeSuccessor = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  recovery: EndpointRecovery,
  request: CatchUpRequestValue,
): Effect.Effect<CatchUpSuccessor | undefined, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const rows = successorRows(recovery, request);
    if (rows.length > 1) {
      return yield* persistenceFailure();
    }
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    const item =
      "canonicalCertifiedRecord" in row
        ? yield* decodeCanonical(
            CertifiedRecord,
            row.canonicalCertifiedRecord,
          ).pipe(
            Effect.flatMap((record) =>
              verifyCertifiedRecord({
                record,
                registrySignerPublicKey: runtime.input.registrySignerPublicKey,
              }).pipe(Effect.as(record)),
            ),
            Effect.mapError(persistenceFailure),
          )
        : yield* decodeCanonical(CompletedReanchor, row.canonicalAnchor).pipe(
            Effect.flatMap((completed) =>
              verifyCompletedReanchor({ completed, membership }).pipe(
                Effect.as(completed),
              ),
            ),
            Effect.mapError(persistenceFailure),
          );
    const later = successorRows(recovery, nextRequest(request, item));
    if (later.length > 1) {
      return yield* persistenceFailure();
    }
    return { item, hasMore: later.length === 1 };
  });

const encodeAttestation = (
  runtime: EngineRuntime,
  request: CatchUpRequestValue,
  item: Readonly<{
    kind: "certified_record" | "completed_reanchor" | "incomplete";
    hash: RecordHash | AnchorHash | null;
    hasMore: boolean;
  }>,
) =>
  signEvidenceMessage({
    statement: {
      moltzapVersion: request.moltzapVersion,
      kind: "catch_up_attestation",
      signerAgentId: runtime.input.localAgentCard.agentId,
      request,
      itemKind: item.kind,
      itemHash: item.hash,
      hasMore: item.hasMore,
    },
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.flatMap((message) => Schema.encode(SignedMessage)(message)),
    Effect.mapError(persistenceFailure),
  );

const sendIncomplete = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  request: CatchUpRequestValue,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const attestation = yield* encodeAttestation(runtime, request, {
      kind: "incomplete",
      hash: null,
      hasMore: false,
    });
    yield* queueSignedPacket(
      runtime,
      membership,
      {
        moltzapVersion: request.moltzapVersion,
        kind: "catch_up_incomplete",
        request,
        attestation,
      },
      false,
    );
  });

const sendPage = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  request: CatchUpRequestValue,
  next: CatchUpSuccessor,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const hash =
      next.item.kind === "certified_record"
        ? next.item.recordHash
        : next.item.anchorHash;
    const attestation = yield* encodeAttestation(runtime, request, {
      kind: next.item.kind,
      hash,
      hasMore: next.hasMore,
    });
    yield* queueSignedPacket(
      runtime,
      membership,
      {
        moltzapVersion: request.moltzapVersion,
        kind: "catch_up_page",
        request,
        item: next.item,
        hasMore: next.hasMore,
        attestation,
      },
      false,
    );
  });

const respond = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  request: CatchUpRequestValue,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const recovery = yield* runtime.input.store
      .recover()
      .pipe(Effect.mapError(persistenceFailure));
    const next = yield* decodeSuccessor(runtime, membership, recovery, request);
    if (next === undefined) {
      yield* sendIncomplete(runtime, membership, request);
      return;
    }
    yield* sendPage(runtime, membership, request, next);
  });

const requestIsEligible = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  request: CatchUpRequestValue,
  membership?: VerifiedMembership,
): membership is VerifiedMembership => {
  if (membership === undefined) {
    return false;
  }
  const senderAgentId = ingress.message.senderAgentId;
  return (
    senderAgentId !== runtime.input.localAgentCard.agentId &&
    senderAgentId === request.requesterAgentId &&
    request.membershipHash === membership.hash &&
    memberCard(membership, request.requesterAgentId) !== undefined
  );
};

const acceptRequest = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  request: CatchUpRequestValue,
) => {
  const membership = membershipFor(runtime, request.conversationId);
  if (!requestIsEligible(runtime, ingress, request, membership)) {
    return Effect.succeed(ignored);
  }
  return verifyOuterMessage({ message: ingress.message, membership }).pipe(
    Effect.flatMap(() => respond(runtime, membership, request)),
    Effect.as(accepted),
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
  );
};

const sameRequestPosition = (
  left: CatchUpRequestValue,
  right: CatchUpRequestValue,
) =>
  left.knownRecordHash === right.knownRecordHash &&
  left.knownAnchorHash === right.knownAnchorHash;

const sameRequest = (left: CatchUpRequestValue, right: CatchUpRequestValue) =>
  left.conversationId === right.conversationId &&
  left.membershipHash === right.membershipHash &&
  left.requesterAgentId === right.requesterAgentId &&
  sameRequestPosition(left, right);

const extendsRequest = (page: CatchUpPage): boolean => {
  if (page.item.kind === "completed_reanchor") {
    if (page.request.knownRecordHash === null) {
      return false;
    }
    return (
      page.item.reanchor.previousAnchorHash === page.request.knownAnchorHash &&
      page.item.reanchor.selectedRecordHash === page.request.knownRecordHash
    );
  }
  if (
    page.item.actionCertifiedRecord.action.previousRecordHash !==
    page.request.knownRecordHash
  ) {
    return false;
  }
  return (
    page.request.knownAnchorHash === null ||
    page.item.actionCertifiedRecord.anchorHash === page.request.knownAnchorHash
  );
};

interface CatchUpContext {
  readonly state: EngineRecoveryState;
  readonly membership: VerifiedMembership;
}

const catchUpContext = (
  runtime: EngineRuntime,
  request: CatchUpRequestValue,
  senderAgentId: SignedMessageValue["senderAgentId"],
): CatchUpContext | undefined => {
  const state = states.get(runtime);
  if (state === undefined) {
    return undefined;
  }
  const membership = state.memberships.get(request.conversationId);
  if (membership === undefined) {
    return undefined;
  }
  const pending = state.pendingRequests.get(request.conversationId);
  if (pending === undefined) {
    return undefined;
  }
  if (!sameRequest(pending, request)) {
    return undefined;
  }
  if (senderAgentId === runtime.input.localAgentCard.agentId) {
    return undefined;
  }
  if (memberCard(membership, senderAgentId) === undefined) {
    return undefined;
  }
  return { state, membership };
};

const applyCompletedAnchor = (
  runtime: EngineRuntime,
  completed: CompletedReanchorValue,
) =>
  Effect.gen(function* () {
    const canonicalBody = yield* encodeCanonical(
      ReanchorBody,
      completed.reanchor,
    );
    const canonicalCompletedReanchor = yield* encodeCanonical(
      CompletedReanchor,
      completed,
    );
    yield* runtime.input.store.applyCatchUpReanchor({
      conversationId: completed.reanchor.conversationId,
      anchorHash: completed.anchorHash,
      previousAnchorHash: completed.reanchor.previousAnchorHash,
      routerInstanceId: completed.reanchor.routerInstanceId,
      selectedRecordHash: completed.reanchor.selectedRecordHash,
      canonicalBody,
      canonicalCompletedReanchor,
    });
    const conversation = runtime.conversations.get(
      completed.reanchor.conversationId,
    );
    if (conversation !== undefined) {
      conversation.currentAnchor = completed;
    }
  }).pipe(Effect.mapError(persistenceFailure));

const restoreConversation = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  record: CertifiedRecordValue,
) =>
  Effect.gen(function* () {
    const action = record.actionCertifiedRecord.action;
    const recovery = yield* runtime.input.store.recover();
    const intent = recovery.startIntents.find(
      (item) => item.conversationId === action.conversationId,
    );
    if (
      action.kind !== "start_action" ||
      record.routerAnchor.kind !== "genesis_anchor" ||
      intent === undefined
    ) {
      return yield* persistenceFailure();
    }
    return {
      foldKind: "start",
      conversationId: action.conversationId,
      canonicalIntent: intent.canonicalIntent,
      membership,
      genesisAnchor: record.routerAnchor,
      currentAnchor: record.routerAnchor,
      action,
      actionSignatures: new Map(),
      durabilityVotes: new Map(),
      actionSignatureQueued: false,
      durabilityVoteQueued: false,
      certifiedBroadcastQueued: true,
      actionCertifiedRecord: record.actionCertifiedRecord,
      recordHash: record.recordHash,
      certifiedRecord: record,
    } satisfies EngineConversation;
  });

const installCaughtUpHead = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  record: CertifiedRecordValue,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const action = record.actionCertifiedRecord.action;
    let conversation = runtime.conversations.get(action.conversationId);
    if (conversation === undefined) {
      conversation = yield* restoreConversation(runtime, membership, record);
      runtime.conversations.set(action.conversationId, conversation);
    }
    conversation.head = {
      recordHash: record.recordHash,
      action,
      certifiedRecord: record,
    };
    if (action.kind === "start_action") {
      conversation.actionCertifiedRecord = record.actionCertifiedRecord;
      conversation.recordHash = record.recordHash;
      conversation.certifiedRecord = record;
      runtime.recordFolds.set(record.recordHash, conversation);
      const completion = runtime.completions.get(action.conversationId);
      if (completion !== undefined) {
        yield* Deferred.succeed(completion, undefined);
      }
    }
  }).pipe(Effect.mapError(persistenceFailure));

const applyPage = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  page: CatchUpPage,
) => {
  if (page.item.kind === "completed_reanchor") {
    return applyCompletedAnchor(runtime, page.item);
  }
  const record = page.item;
  return Effect.gen(function* () {
    if (record.routerAnchor.kind === "completed_reanchor") {
      const { position } = yield* runtime.input.store.recover().pipe(
        Effect.map((recovery) => ({
          position: positionFor(
            recovery,
            record.actionCertifiedRecord.action.conversationId,
          ),
        })),
      );
      if (position?.currentAnchorHash !== record.routerAnchor.anchorHash) {
        yield* applyCompletedAnchor(runtime, record.routerAnchor);
      }
    }
    const action = record.actionCertifiedRecord.action;
    yield* runtime.input.store.applyCatchUpRecord({
      conversationId: action.conversationId,
      recordHash: record.recordHash,
      ...(action.previousRecordHash === null
        ? {}
        : { previousRecordHash: action.previousRecordHash }),
      membershipHash: action.membershipHash,
      anchorHash: action.anchorHash,
      canonicalRecord: yield* encodeCanonical(
        ActionCertifiedRecord,
        record.actionCertifiedRecord,
      ),
      canonicalCertifiedRecord: yield* encodeCanonical(CertifiedRecord, record),
    });
    yield* installCaughtUpHead(runtime, membership, record);
  }).pipe(Effect.mapError(persistenceFailure));
};

const attestationMatchesOuter = (
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  representation: unknown,
) =>
  Schema.decodeUnknown(SignedMessage)(representation).pipe(
    Effect.map(
      (message) => message.senderAgentId === ingress.message.senderAgentId,
    ),
    Effect.catchAll(() => Effect.succeed(false)),
  );

const acceptPage = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  page: CatchUpPage,
) => {
  const context = catchUpContext(
    runtime,
    page.request,
    ingress.message.senderAgentId,
  );
  if (context === undefined) {
    return Effect.succeed(ignored);
  }
  if (!extendsRequest(page)) {
    return Effect.succeed(ignored);
  }
  return Effect.gen(function* () {
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: context.membership,
    });
    if (!(yield* attestationMatchesOuter(ingress, page.attestation))) {
      return ignored;
    }
    yield* verifyCatchUpPage({
      page,
      membership: context.membership,
      registrySignerPublicKey: runtime.input.registrySignerPublicKey,
    });
    yield* applyPage(runtime, context.membership, page);
    yield* requestCertifiedHistory(runtime, page.request.conversationId).pipe(
      Effect.mapError(persistenceFailure),
    );
    return accepted;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
  );
};

const acceptIncomplete = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: CatchUpIncomplete,
) => {
  const context = catchUpContext(
    runtime,
    packet.request,
    ingress.message.senderAgentId,
  );
  if (context === undefined) {
    return Effect.succeed(ignored);
  }
  return Effect.gen(function* () {
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: context.membership,
    });
    if (!(yield* attestationMatchesOuter(ingress, packet.attestation))) {
      return ignored;
    }
    yield* verifyCatchUpIncomplete({
      incomplete: packet,
      membership: context.membership,
    });
    const responders =
      context.state.incompleteResponders.get(packet.request.conversationId) ??
      new Set<string>();
    responders.add(ingress.message.senderAgentId);
    context.state.incompleteResponders.set(
      packet.request.conversationId,
      responders,
    );
    if (responders.size < context.membership.members.length - 1) {
      return accepted;
    }
    context.state.pendingRequests.delete(packet.request.conversationId);
    context.state.incompleteResponders.delete(packet.request.conversationId);
    yield* context.state
      .onPositionReady(packet.request.conversationId)
      .pipe(Effect.mapError(persistenceFailure));
    return accepted;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
  );
};

/**
 * Accept or answer one catch-up packet without runtime attention.
 * @param runtime Endpoint runtime that owns the packet state.
 * @param ingress Authenticated Router ingress carrying the packet.
 * @param packet Decoded catch-up protocol packet.
 * @returns The packet disposition or a persistence failure.
 */
export const acceptCatchUpPacket = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: CatchUpRequestValue | CatchUpPage | CatchUpIncomplete,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> => {
  switch (packet.kind) {
    case "catch_up_request":
      return acceptRequest(runtime, ingress, packet);
    case "catch_up_page":
      return acceptPage(runtime, ingress, packet);
    case "catch_up_incomplete":
      return acceptIncomplete(runtime, ingress, packet);
    default: {
      const exhaustive: never = packet;
      return exhaustive;
    }
  }
};

/**
 * Decode every durable membership needed by one recovery generation.
 * @param runtime Endpoint runtime with the Registry verification key.
 * @param recovery Durable recovery snapshot containing memberships.
 * @returns Verified memberships keyed by conversation identifier.
 */
export const recoverMemberships = (
  runtime: EngineRuntime,
  recovery: EndpointRecovery,
): Effect.Effect<
  Map<ConversationId, VerifiedMembership>,
  RouterWorkerRecoveryError
> =>
  Effect.forEach(
    recovery.memberships,
    (stored) =>
      decodeCanonical(Membership, stored.canonicalMembership).pipe(
        Effect.flatMap((membership) =>
          verifyMembership(membership, runtime.input.registrySignerPublicKey),
        ),
        Effect.mapError(recoveryFailure),
        Effect.map(
          (membership) =>
            [membership.membership.conversationId, membership] as const,
        ),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((entries) => new Map(entries)));
