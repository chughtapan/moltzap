/** @file Authenticated catch-up coordination and recovery lifecycle. */

import {
  type AgentId,
  MOLTZAP_VERSION,
  SignedMessage,
} from "@moltzap/identity";
import { Deferred, Effect, Fiber, Queue, Schema, type Scope } from "effect";
import type { EngineRuntime } from "../engine-types.js";
import type { EndpointRecovery, StoredOutboundMessage } from "../store.js";
import { resumeDisseminationObligations } from "../engine-dissemination.js";
import { proposeIntent } from "../engine-send.js";
import {
  acceptEngineIngress as acceptProtocolIngress,
  acceptEngineRecoveryIngress as acceptProtocolRecoveryIngress,
  resumeEngineFolds,
} from "../protocol/index.js";
import {
  type AnchorHash as AnchorHashValue,
  type CatchUpIncomplete,
  type CatchUpPage,
  type CatchUpRequest as CatchUpRequestValue,
  type CertifiedRecord,
  CompletedReanchor,
  type CompletedReanchor as CompletedReanchorValue,
  type ConversationId as ConversationIdValue,
  type DecodedOuterBody,
  type DirectPacket,
  encodeCanonical,
  memberCard,
  ReanchorBody,
  type RecordHash as RecordHashValue,
  signEvidenceMessage,
  type VerifiedMembership,
  verifyCatchUpIncomplete,
  verifyCatchUpPage,
  verifyOuterMessage,
} from "../representation.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
  type RouterWorkerRecovery,
  RouterWorkerRecoveryError,
  type RouterWorkerSendError,
} from "../router-worker/index.js";
import { completeRecoveryBarrier, currentRecoveryBarrier } from "./barrier.js";
import {
  acceptCompletedReanchor,
  acceptReanchorVote,
  positionReady,
} from "./reanchor/index.js";
import {
  type ActiveRecoveryState,
  clearRecoveryState,
  completeRecoveryIfIdle,
  currentRecoveryState,
  installRecoveryState,
  makeRecoveryState,
  outboundCommitted,
  queueRecoveryPacket,
  recoverMemberships,
  requestCertifiedHistory,
} from "./state.js";
import {
  decodeStoredAnchor,
  recordFromStore,
  verifyRecoveredHistory,
  verifyStoredOutbounds,
} from "./store.js";

/** Reconstruct the complete private engine state from durable storage. */
export { recoverEngineState } from "./store.js";

interface CatchUpSuccessor {
  readonly item: CertifiedRecord | CompletedReanchorValue;
  readonly hasMore: boolean;
}

type CatchUpSuccessorRow =
  | Readonly<{
      kind: "record";
      value: EndpointRecovery["certifiedRecords"][number];
    }>
  | Readonly<{
      kind: "reanchor";
      value: EndpointRecovery["anchors"][number];
    }>;

const acceptedDisposition: RouterIngressDisposition = "accepted";
const ignoredDisposition: RouterIngressDisposition = "ignored";

/**
 * Accept active protocol traffic and answer authenticated catch-up requests.
 * @param runtime Engine whose active protocol state receives the ingress.
 * @param ingress Verified Router delivery and decoded private payload.
 * @returns Whether the payload was accepted or safely ignored.
 */
export function acceptEngineIngressWithRecovery(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return ingress.payload.kind === "direct" &&
    ingress.payload.packet.kind === "catch_up_request"
    ? acceptCatchUpRequest(runtime, ingress, ingress.payload.packet)
    : acceptProtocolIngress(runtime, ingress);
}

/**
 * Dispatch only certified-history and re-anchor traffic during recovery.
 * @param runtime Engine participating in the active recovery session.
 * @param ingress Verified Router delivery and decoded private payload.
 * @returns Whether the recovery payload was accepted or safely ignored.
 */
export function acceptEngineRecoveryIngressWithRecovery(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  if (ingress.payload.kind === "evidence") {
    return acceptReanchorVote(runtime, ingress, ingress.payload.message);
  }
  return acceptRecoveryPacket(runtime, ingress, ingress.payload.packet);
}

/**
 * Reconcile every certified chain and threshold-anchor a restarted Router.
 * @param runtime Engine whose durable histories require reconciliation.
 * @param recoveryInput Authenticated Router recovery callbacks and new anchor.
 * @returns Completion after history, folds, and pending intents resume safely.
 */
export const recoverCertifiedHistory = (
  runtime: EngineRuntime,
  recoveryInput: RouterWorkerRecovery,
): Effect.Effect<void, RouterWorkerRecoveryError | RouterWorkerSendError> =>
  Effect.gen(function* () {
    const barrier = currentRecoveryBarrier(runtime);
    if (barrier === undefined) {
      return yield* Effect.fail(recoveryFailure());
    }
    if (currentRecoveryState(runtime) !== undefined) {
      return yield* Effect.fail(recoveryFailure());
    }
    const recovered = yield* runtime.input.store
      .recover()
      .pipe(Effect.mapError(recoveryFailure));
    const memberships = yield* recoverMemberships(runtime, recovered);
    yield* verifyRecoveredHistory(runtime, recovered, memberships);
    const retainedOutbounds = yield* prepareRecoveryOutbox(
      runtime,
      recoveryInput,
      recovered,
      memberships,
    );
    const state = yield* makeRecoveryState(recoveryInput, memberships);
    yield* Effect.sync(() => {
      installRecoveryState(runtime, state);
    });
    yield* Effect.scoped(runRecovery(runtime, state, retainedOutbounds)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          clearRecoveryState(runtime, state);
        }),
      ),
    );
    yield* completeRecoveryBarrier(runtime, barrier);
  }).pipe(Effect.withSpan("recoverCertifiedHistory"));

/**
 * Verify retained outer envelopes and invalidate only rows bound to an old Router.
 * @param runtime Engine whose local identity authored the retained envelopes.
 * @param recovery Router discontinuity and current recovery transport.
 * @param snapshot Exact durable state captured before recovery starts.
 * @param memberships Verified membership for every retained conversation.
 * @returns Same-instance rows that must resume with their stable outbox identity.
 */
function prepareRecoveryOutbox(
  runtime: EngineRuntime,
  recovery: RouterWorkerRecovery,
  snapshot: EndpointRecovery,
  memberships: ReadonlyMap<ConversationIdValue, VerifiedMembership>,
): Effect.Effect<readonly StoredOutboundMessage[], RouterWorkerRecoveryError> {
  return verifyStoredOutbounds(
    runtime.input,
    snapshot.outboundMessages,
    memberships,
  ).pipe(
    Effect.mapError(recoveryFailure),
    Effect.flatMap((outbounds) => {
      switch (recovery.reason) {
        case "feed_gap":
        case "cursor_invalid":
          return Effect.succeed(outbounds);
        case "router_restarted":
          return discardRestartedOutbounds(runtime, outbounds);
        default: {
          const exhaustive: never = recovery.reason;
          return exhaustive;
        }
      }
    }),
    Effect.withSpan("prepareRecoveryOutbox"),
  );
}

/**
 * Resume retained same-instance envelopes in durable insertion order.
 * @param recovery Recovery transport fenced to the active Router instance.
 * @param outbounds Verified current envelopes retained by the endpoint store.
 * @returns Completion after every stable outbox identity is accepted or inactive.
 */
function resumeRecoveryOutbox(
  recovery: RouterWorkerRecovery,
  outbounds: readonly StoredOutboundMessage[],
): Effect.Effect<void, RouterWorkerSendError> {
  return Effect.forEach(
    outbounds,
    (outbound) => recovery.resume(outbound.outboundId),
    { concurrency: 1, discard: true },
  ).pipe(Effect.withSpan("resumeRecoveryOutbox"));
}

function discardRestartedOutbounds(
  runtime: EngineRuntime,
  outbounds: readonly StoredOutboundMessage[],
): Effect.Effect<readonly StoredOutboundMessage[], RouterWorkerRecoveryError> {
  if (outbounds.length === 0) {
    return Effect.succeed([]);
  }
  return runtime.input.store
    .discardOutbound(outbounds)
    .pipe(Effect.mapError(recoveryFailure), Effect.as([]));
}

function acceptRecoveryPacket(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: DirectPacket,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  switch (packet.kind) {
    case "catch_up_request":
      return acceptCatchUpRequest(runtime, ingress, packet);
    case "catch_up_page":
      return acceptCatchUpPage(runtime, ingress, packet);
    case "catch_up_incomplete":
      return acceptCatchUpIncomplete(runtime, ingress, packet);
    case "completed_reanchor":
      return acceptCompletedReanchor(runtime, ingress, packet);
    case "certified_record":
      return acceptRecoveryRecord(runtime, ingress);
    case "action_proposal":
    case "action_certified_record":
      return Effect.succeed(ignoredDisposition);
    default: {
      const exhaustive: never = packet;
      return exhaustive;
    }
  }
}

function recoveryFailure(): RouterWorkerRecoveryError {
  return new RouterWorkerRecoveryError();
}

function acceptCatchUpRequest(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  request: CatchUpRequestValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const membership = membershipFor(runtime, request.conversationId);
  if (membership === undefined) {
    return Effect.succeed(ignoredDisposition);
  }
  const senderAgentId = ingress.message.senderAgentId;
  const requestMatchesMembership =
    senderAgentId !== runtime.input.localAgentCard.agentId &&
    senderAgentId === request.requesterAgentId &&
    request.membershipHash === membership.hash &&
    memberCard(membership, senderAgentId) !== undefined;
  if (!requestMatchesMembership) {
    return Effect.succeed(ignoredDisposition);
  }
  return verifyOuterMessage({
    message: ingress.message,
    membership,
  }).pipe(
    Effect.flatMap(() => respondToCatchUp(runtime, membership, request)),
    Effect.as(acceptedDisposition),
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
  );
}

function membershipFor(
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
): VerifiedMembership | undefined {
  return (
    currentRecoveryState(runtime)?.memberships.get(conversationId) ??
    runtime.conversations.get(conversationId)?.membership
  );
}

function respondToCatchUp(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  request: CatchUpRequestValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return runtime.input.store.recover().pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((recovery) =>
      decodeCatchUpSuccessor(runtime, membership, recovery, request),
    ),
    Effect.flatMap((successor) =>
      successor === undefined
        ? sendCatchUpIncomplete(runtime, membership, request)
        : sendCatchUpPage(runtime, membership, request, successor),
    ),
  );
}

function decodeCatchUpSuccessor(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  recovery: EndpointRecovery,
  request: CatchUpRequestValue,
): Effect.Effect<CatchUpSuccessor | undefined, RouterWorkerPersistenceError> {
  return Effect.gen(function* () {
    const rows = successorRows(recovery, request);
    if (rows.length > 1) {
      return yield* Effect.fail(persistenceFailure());
    }
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    const item = yield* decodeSuccessorRow(runtime, membership, recovery, row);
    const later = successorRows(recovery, nextRequest(request, item));
    if (later.length > 1) {
      return yield* Effect.fail(persistenceFailure());
    }
    return { item, hasMore: later.length === 1 };
  }).pipe(Effect.mapError(persistenceFailure));
}

function decodeSuccessorRow(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  recovery: EndpointRecovery,
  row: CatchUpSuccessorRow,
) {
  if (row.kind === "record") {
    return decodeStoredRecordSuccessor(runtime, membership, recovery, row);
  }
  return decodeStoredAnchor(membership, row.value).pipe(
    Effect.flatMap((anchor) =>
      anchor.kind === "completed_reanchor"
        ? Effect.succeed(anchor)
        : Effect.fail(persistenceFailure()),
    ),
  );
}

function decodeStoredRecordSuccessor(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  recovery: EndpointRecovery,
  row: Extract<CatchUpSuccessorRow, { readonly kind: "record" }>,
) {
  const anchor = recovery.anchors.find(
    (candidate) =>
      candidate.conversationId === row.value.conversationId &&
      candidate.anchorHash === row.value.anchorHash,
  );
  if (anchor === undefined) {
    return Effect.fail(persistenceFailure());
  }
  return decodeStoredAnchor(membership, anchor).pipe(
    Effect.flatMap((decodedAnchor) =>
      recordFromStore(runtime.input, row.value, decodedAnchor),
    ),
  );
}

function successorRows(
  recovery: EndpointRecovery,
  request: CatchUpRequestValue,
): readonly CatchUpSuccessorRow[] {
  if (request.knownRecordHash === null) {
    return recovery.certifiedRecords
      .filter(
        (record) =>
          record.conversationId === request.conversationId &&
          record.previousRecordHash === undefined,
      )
      .map((value) => recordSuccessor(value));
  }
  const reanchors = recovery.anchors
    .filter(
      (anchor) =>
        anchor.conversationId === request.conversationId &&
        anchor.previousAnchorHash === request.knownAnchorHash &&
        anchor.selectedRecordHash === request.knownRecordHash,
    )
    .map((value) => reanchorSuccessor(value));
  const records = recovery.certifiedRecords
    .filter(
      (record) =>
        record.conversationId === request.conversationId &&
        record.previousRecordHash === request.knownRecordHash &&
        record.anchorHash === request.knownAnchorHash,
    )
    .map((value) => recordSuccessor(value));
  return [...reanchors, ...records];
}

function recordSuccessor(
  value: EndpointRecovery["certifiedRecords"][number],
): CatchUpSuccessorRow {
  return { kind: "record", value };
}

function reanchorSuccessor(
  value: EndpointRecovery["anchors"][number],
): CatchUpSuccessorRow {
  return { kind: "reanchor", value };
}

function nextRequest(
  request: CatchUpRequestValue,
  item: CertifiedRecord | CompletedReanchorValue,
): CatchUpRequestValue {
  if (item.kind === "completed_reanchor") {
    return { ...request, knownAnchorHash: item.anchorHash };
  }
  return {
    ...request,
    knownRecordHash: item.actionCertifiedRecord.recordHash,
    knownAnchorHash: item.actionCertifiedRecord.recordCore.anchorHash,
  };
}

function sendCatchUpIncomplete(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  request: CatchUpRequestValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.gen(function* () {
    const attestation = yield* signCatchUpAttestation(runtime, request, {
      kind: "incomplete",
      hash: null,
      hasMore: false,
    });
    yield* queueRecoveryPacket(runtime, membership, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_incomplete",
      request,
      attestation,
    });
  });
}

function sendCatchUpPage(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  request: CatchUpRequestValue,
  successor: CatchUpSuccessor,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.gen(function* () {
    const hash =
      successor.item.kind === "certified_record"
        ? successor.item.actionCertifiedRecord.recordHash
        : successor.item.anchorHash;
    const attestation = yield* signCatchUpAttestation(runtime, request, {
      kind: successor.item.kind,
      hash,
      hasMore: successor.hasMore,
    });
    yield* queueRecoveryPacket(runtime, membership, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_page",
      request,
      item: successor.item,
      hasMore: successor.hasMore,
      attestation,
    });
  });
}

function signCatchUpAttestation(
  runtime: EngineRuntime,
  request: CatchUpRequestValue,
  item: Readonly<{
    kind: "certified_record" | "completed_reanchor" | "incomplete";
    hash: RecordHashValue | AnchorHashValue | null;
    hasMore: boolean;
  }>,
) {
  return signEvidenceMessage({
    statement: {
      moltzapVersion: MOLTZAP_VERSION,
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
}

function acceptCatchUpPage(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  page: CatchUpPage,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const context = pendingCatchUpContext(
    runtime,
    page.request,
    ingress.message.senderAgentId,
  );
  if (context === undefined) {
    return Effect.succeed(ignoredDisposition);
  }
  return Effect.gen(function* () {
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: context.membership,
    });
    yield* verifyCatchUpPage({
      page,
      membership: context.membership,
      responseSenderAgentId: ingress.message.senderAgentId,
      registrySignerPublicKey: runtime.input.registrySignerPublicKey,
    });
    const key = requestKey(page.request);
    const successorHash = pageSuccessorHash(page);
    const retained = context.state.acceptedSuccessors.get(key);
    if (retained !== undefined) {
      return retained === successorHash
        ? acceptedDisposition
        : yield* Effect.fail(persistenceFailure());
    }
    if (!sameRequest(context.pending, page.request)) {
      return ignoredDisposition;
    }
    yield* applyCatchUpPage(runtime, ingress, page);
    yield* Effect.sync(() => {
      context.state.acceptedSuccessors.set(key, successorHash);
    });
    yield* requestCertifiedHistory(runtime, page.request.conversationId);
    return acceptedDisposition;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
  );
}

function pageSuccessorHash(
  page: CatchUpPage,
): RecordHashValue | AnchorHashValue {
  return page.item.kind === "certified_record"
    ? page.item.actionCertifiedRecord.recordHash
    : page.item.anchorHash;
}

function applyCatchUpPage(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  page: CatchUpPage,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  if (page.item.kind === "completed_reanchor") {
    return applyCaughtUpReanchor(runtime, page.item);
  }
  const recordIngress: RouterWorkerIngress<DecodedOuterBody> = {
    ...ingress,
    payload: { kind: "direct", packet: page.item },
  };
  return acceptProtocolRecoveryIngress(runtime, recordIngress).pipe(
    Effect.flatMap((disposition) =>
      disposition === "accepted"
        ? Effect.void
        : Effect.fail(persistenceFailure()),
    ),
  );
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}

function applyCaughtUpReanchor(
  runtime: EngineRuntime,
  completed: CompletedReanchorValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.gen(function* () {
    yield* runtime.input.store.applyCatchUpReanchor({
      conversationId: completed.reanchor.conversationId,
      anchorHash: completed.anchorHash,
      previousAnchorHash: completed.reanchor.previousAnchorHash,
      routerInstanceId: completed.reanchor.routerInstanceId,
      selectedRecordHash: completed.reanchor.selectedRecordHash,
      canonicalBody: yield* encodeCanonical(
        ReanchorBody,
        completed.reanchor,
      ).pipe(Effect.mapError(persistenceFailure)),
      canonicalCompletedReanchor: yield* encodeCanonical(
        CompletedReanchor,
        completed,
      ).pipe(Effect.mapError(persistenceFailure)),
    });
    yield* Effect.sync(() => {
      const conversation = runtime.conversations.get(
        completed.reanchor.conversationId,
      );
      if (conversation !== undefined) {
        conversation.currentAnchor = completed;
      }
    });
  }).pipe(Effect.mapError(persistenceFailure));
}

function acceptCatchUpIncomplete(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  incomplete: CatchUpIncomplete,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const context = pendingCatchUpContext(
    runtime,
    incomplete.request,
    ingress.message.senderAgentId,
  );
  if (context === undefined) {
    return Effect.succeed(ignoredDisposition);
  }
  return Effect.gen(function* () {
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: context.membership,
    });
    yield* verifyCatchUpIncomplete({
      incomplete,
      membership: context.membership,
      responseSenderAgentId: ingress.message.senderAgentId,
    });
    if (!sameRequest(context.pending, incomplete.request)) {
      return ignoredDisposition;
    }
    const positionIsReady = yield* Effect.sync(() =>
      recordIncompleteResponder(
        context,
        incomplete.request.conversationId,
        ingress.message.senderAgentId,
      ),
    );
    if (!positionIsReady) {
      return acceptedDisposition;
    }
    yield* positionReady(runtime, incomplete.request.conversationId);
    return acceptedDisposition;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
  );
}

function recordIncompleteResponder(
  context: Readonly<{
    state: ActiveRecoveryState;
    membership: VerifiedMembership;
  }>,
  conversationId: ConversationIdValue,
  senderAgentId: AgentId,
): boolean {
  const responders =
    context.state.incompleteResponders.get(conversationId) ??
    new Set<AgentId>();
  responders.add(senderAgentId);
  context.state.incompleteResponders.set(conversationId, responders);
  const requiredRemoteResponders = context.membership.members.length - 1;
  if (responders.size < requiredRemoteResponders) {
    return false;
  }
  context.state.pendingRequests.delete(conversationId);
  context.state.incompleteResponders.delete(conversationId);
  return true;
}

function sameRequest(
  left: CatchUpRequestValue,
  right: CatchUpRequestValue,
): boolean {
  return requestKey(left) === requestKey(right);
}

function requestKey(request: CatchUpRequestValue): string {
  return [
    request.conversationId,
    request.membershipHash,
    request.requesterAgentId,
    request.knownRecordHash ?? "null",
    request.knownAnchorHash ?? "null",
  ].join("\u0000");
}

function pendingCatchUpContext(
  runtime: EngineRuntime,
  request: CatchUpRequestValue,
  senderAgentId: AgentId,
):
  | Readonly<{
      state: ActiveRecoveryState;
      membership: VerifiedMembership;
      pending: CatchUpRequestValue;
    }>
  | undefined {
  const state = currentRecoveryState(runtime);
  if (state === undefined) {
    return undefined;
  }
  const membership = state.memberships.get(request.conversationId);
  const pending = state.pendingRequests.get(request.conversationId);
  if (membership === undefined || pending === undefined) {
    return undefined;
  }
  if (senderAgentId === runtime.input.localAgentCard.agentId) {
    return undefined;
  }
  if (memberCard(membership, senderAgentId) === undefined) {
    return undefined;
  }
  return { state, membership, pending };
}

function acceptRecoveryRecord(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return acceptProtocolRecoveryIngress(runtime, ingress).pipe(
    Effect.tap((disposition) => {
      if (
        disposition !== "accepted" ||
        ingress.payload.kind !== "direct" ||
        ingress.payload.packet.kind !== "certified_record"
      ) {
        return Effect.void;
      }
      return requestCertifiedHistory(
        runtime,
        ingress.payload.packet.actionCertifiedRecord.recordCore.action
          .conversationId,
      );
    }),
  );
}

function runRecovery(
  runtime: EngineRuntime,
  state: ActiveRecoveryState,
  retainedOutbounds: readonly StoredOutboundMessage[],
): Effect.Effect<
  void,
  RouterWorkerRecoveryError | RouterWorkerSendError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const sender = yield* sendRecoveryOutbound(state).pipe(Effect.forkScoped);
    yield* recoverPositions(runtime, state).pipe(
      Effect.mapError(recoveryFailure),
    );
    yield* completeRecoveryIfIdle(state);
    yield* Effect.raceFirst(
      Deferred.await(state.completion),
      Fiber.join(sender),
    );
    yield* resumeDisseminationObligations(runtime).pipe(
      Effect.mapError(recoveryFailure),
    );
    yield* resumeRecoveryOutbox(state.recovery, retainedOutbounds);
    yield* resumeEngineFolds(runtime).pipe(Effect.mapError(recoveryFailure));
    yield* resumePendingIntents(runtime, state.recovery);
  });
}

function sendRecoveryOutbound(
  state: ActiveRecoveryState,
): Effect.Effect<never, RouterWorkerSendError> {
  return Queue.take(state.outbound).pipe(
    Effect.flatMap((message) => state.recovery.send(message)),
    Effect.tap(() => outboundCommitted(state)),
    Effect.forever,
  );
}

function recoverPositions(
  runtime: EngineRuntime,
  state: ActiveRecoveryState,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.forEach(
    state.memberships.keys(),
    (conversationId) => requestCertifiedHistory(runtime, conversationId),
    { concurrency: 1, discard: true },
  );
}

function resumePendingIntents(
  runtime: EngineRuntime,
  recovery: RouterWorkerRecovery,
): Effect.Effect<void, RouterWorkerRecoveryError | RouterWorkerSendError> {
  return runtime.outboundGate.withPermits(1)(
    preparePendingIntents(runtime, recovery).pipe(
      Effect.zipRight(resumeUncompletedIntents(runtime)),
      Effect.zipRight(sendResumedOutbound(runtime, recovery)),
    ),
  );
}

function preparePendingIntents(
  runtime: EngineRuntime,
  recovery: RouterWorkerRecovery,
): Effect.Effect<void> {
  switch (recovery.reason) {
    case "feed_gap":
    case "cursor_invalid":
      return Effect.void;
    case "router_restarted":
      return resetPendingIntents(runtime);
    default: {
      const exhaustive: never = recovery.reason;
      return exhaustive;
    }
  }
}

function resetPendingIntents(runtime: EngineRuntime): Effect.Effect<void> {
  return Effect.sync(() => {
    for (const intent of runtime.intents.values()) {
      if (!runtime.completedPostIds.has(intent.intent.postId)) {
        intent.proposedActionHash = undefined;
      }
    }
  });
}

function resumeUncompletedIntents(
  runtime: EngineRuntime,
): Effect.Effect<void, RouterWorkerRecoveryError> {
  return Effect.forEach(
    runtime.intents.values(),
    (intent) =>
      runtime.completedPostIds.has(intent.intent.postId)
        ? Effect.void
        : proposeIntent(runtime, intent).pipe(Effect.mapError(recoveryFailure)),
    { concurrency: 1, discard: true },
  );
}

function sendResumedOutbound(
  runtime: EngineRuntime,
  recovery: RouterWorkerRecovery,
): Effect.Effect<void, RouterWorkerSendError> {
  return Effect.sync(() => runtime.outbound.shift()).pipe(
    Effect.flatMap((outboundId) =>
      outboundId === undefined
        ? Effect.void
        : recovery
            .resume(outboundId)
            .pipe(Effect.zipRight(sendResumedOutbound(runtime, recovery))),
    ),
  );
}
