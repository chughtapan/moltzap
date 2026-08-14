/** @file Authenticated fixed-member one-item catch-up and recovery state. */

import {
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Deferred, Effect, Queue, Schema } from "effect";
import type { ConversationId } from "../contract.js";
import type { EngineRuntime } from "./engine-types.js";
import {
  ActionCertifiedRecord,
  AnchorHash,
  CatchUpRequest,
  type CatchUpRequest as CatchUpRequestValue,
  type CatchUpIncomplete,
  type CatchUpPage,
  CertifiedRecord,
  type CertifiedRecord as CertifiedRecordValue,
  ClientRepresentationError,
  CompletedReanchor,
  type CompletedReanchor as CompletedReanchorValue,
  decodeCanonical,
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
import type { DecodedOuterBody, DirectPacket } from "./representation.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
  RouterWorkerRecoveryError,
  type RouterWorkerRecovery,
} from "./router-worker.js";
import type { EndpointRecovery, StoredAnchor } from "./store.js";

const accepted = "accepted" as const;
const ignored = "ignored" as const;
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

/** Install one Router recovery generation before sending protocol traffic. */
export const installEngineRecoveryState = (
  runtime: EngineRuntime,
  state: EngineRecoveryState,
): void => {
  states.set(runtime, state);
};

/** Read the active Router recovery generation. */
export const engineRecoveryState = (
  runtime: EngineRuntime,
): EngineRecoveryState | undefined => states.get(runtime);

/** Remove a state only when it is still the installed generation. */
export const removeEngineRecoveryState = (
  runtime: EngineRuntime,
  state: EngineRecoveryState,
): void => {
  if (states.get(runtime) === state) states.delete(runtime);
};

/** Resolve recovery only after every conversation and queued send are durable. */
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

/** Send the exact durable head, using null/null before certified genesis. */
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
  });

const recordsFor = (recovery: EndpointRecovery, id: ConversationId) =>
  recovery.certifiedRecords.filter((item) => item.conversationId === id);
const anchorsFor = (recovery: EndpointRecovery, id: ConversationId) =>
  recovery.anchors.filter((item) => item.conversationId === id);

type CatchUpItem = CertifiedRecordValue | CompletedReanchorValue;

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
): Effect.Effect<
  Readonly<{ item: CatchUpItem; hasMore: boolean }> | undefined,
  RouterWorkerPersistenceError
> =>
  Effect.gen(function* () {
    const rows = successorRows(recovery, request);
    if (rows.length > 1) return yield* persistenceFailure();
    const row = rows[0];
    if (row === undefined) return undefined;
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
    if (later.length > 1) return yield* persistenceFailure();
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
      return;
    }
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

const acceptRequest = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  request: CatchUpRequestValue,
) => {
  const membership = membershipFor(runtime, request.conversationId);
  if (
    membership === undefined ||
    ingress.message.senderAgentId === runtime.input.localAgentCard.agentId ||
    ingress.message.senderAgentId !== request.requesterAgentId ||
    request.membershipHash !== membership.hash ||
    memberCard(membership, request.requesterAgentId) === undefined
  )
    return Effect.succeed(ignored);
  return verifyOuterMessage({ message: ingress.message, membership }).pipe(
    Effect.flatMap(() => respond(runtime, membership, request)),
    Effect.as(accepted),
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
  );
};

const sameRequest = (left: CatchUpRequestValue, right: CatchUpRequestValue) =>
  left.conversationId === right.conversationId &&
  left.membershipHash === right.membershipHash &&
  left.requesterAgentId === right.requesterAgentId &&
  left.knownRecordHash === right.knownRecordHash &&
  left.knownAnchorHash === right.knownAnchorHash;

const extendsRequest = (page: CatchUpPage) =>
  page.item.kind === "completed_reanchor"
    ? page.request.knownRecordHash !== null &&
      page.item.reanchor.previousAnchorHash === page.request.knownAnchorHash &&
      page.item.reanchor.selectedRecordHash === page.request.knownRecordHash
    : page.item.actionCertifiedRecord.action.previousRecordHash ===
        page.request.knownRecordHash &&
      (page.request.knownAnchorHash === null ||
        page.item.actionCertifiedRecord.anchorHash ===
          page.request.knownAnchorHash);

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
    if (conversation !== undefined) conversation.currentAnchor = completed;
  }).pipe(Effect.mapError(persistenceFailure));

const installCaughtUpHead = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  record: CertifiedRecordValue,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const action = record.actionCertifiedRecord.action;
    let conversation = runtime.conversations.get(action.conversationId);
    if (conversation === undefined) {
      const recovery = yield* runtime.input.store.recover();
      const intent = recovery.startIntents.find(
        (item) => item.conversationId === action.conversationId,
      );
      if (
        action.kind !== "start_action" ||
        record.routerAnchor.kind !== "genesis_anchor" ||
        intent === undefined
      )
        return yield* persistenceFailure();
      conversation = {
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
      };
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
      if (completion !== undefined)
        yield* Deferred.succeed(completion, undefined);
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
    Effect.mapError(() => new ClientRepresentationError()),
  );

const acceptPage = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  page: CatchUpPage,
) => {
  const state = states.get(runtime);
  const membership = state?.memberships.get(page.request.conversationId);
  const pending = state?.pendingRequests.get(page.request.conversationId);
  if (
    state === undefined ||
    membership === undefined ||
    pending === undefined ||
    !sameRequest(pending, page.request) ||
    !extendsRequest(page) ||
    ingress.message.senderAgentId === runtime.input.localAgentCard.agentId ||
    memberCard(membership, ingress.message.senderAgentId) === undefined
  )
    return Effect.succeed(ignored);
  return Effect.gen(function* () {
    yield* verifyOuterMessage({ message: ingress.message, membership });
    if (!(yield* attestationMatchesOuter(ingress, page.attestation)))
      return ignored;
    yield* verifyCatchUpPage({
      page,
      membership,
      registrySignerPublicKey: runtime.input.registrySignerPublicKey,
    });
    yield* applyPage(runtime, membership, page);
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
  const state = states.get(runtime);
  const membership = state?.memberships.get(packet.request.conversationId);
  const pending = state?.pendingRequests.get(packet.request.conversationId);
  if (
    state === undefined ||
    membership === undefined ||
    pending === undefined ||
    !sameRequest(pending, packet.request) ||
    ingress.message.senderAgentId === runtime.input.localAgentCard.agentId ||
    memberCard(membership, ingress.message.senderAgentId) === undefined
  )
    return Effect.succeed(ignored);
  return Effect.gen(function* () {
    yield* verifyOuterMessage({ message: ingress.message, membership });
    if (!(yield* attestationMatchesOuter(ingress, packet.attestation)))
      return ignored;
    yield* verifyCatchUpIncomplete({ incomplete: packet, membership });
    const responders =
      state.incompleteResponders.get(packet.request.conversationId) ??
      new Set<string>();
    responders.add(ingress.message.senderAgentId);
    state.incompleteResponders.set(packet.request.conversationId, responders);
    if (responders.size < membership.members.length - 1) return accepted;
    state.pendingRequests.delete(packet.request.conversationId);
    state.incompleteResponders.delete(packet.request.conversationId);
    yield* state
      .onPositionReady(packet.request.conversationId)
      .pipe(Effect.mapError(persistenceFailure));
    return accepted;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
  );
};

/** Accept or answer one catch-up packet without runtime attention. */
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
  }
};

/** Decode every durable membership needed by one recovery generation. */
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
