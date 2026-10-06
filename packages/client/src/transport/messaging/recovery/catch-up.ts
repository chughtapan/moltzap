/**
 * @file Catch-up: a recovery run, or an engine outside one that received a
 * proposal naming a position it lacks, asks every member for the certified
 * history after its durable position, and any endpoint answers such requests.
 */

import {
  type AgentId,
  MOLTZAP_VERSION,
  SignedMessage,
} from "@moltzap/identity";
import { Effect, Schema } from "effect";
import type { EngineRuntime } from "../runtime/index.js";
import {
  type EndpointRecovery,
  isSemanticStoreRejection,
} from "../../../store/index.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "../../router/index.js";
import {
  AnchorHash,
  type AnchorHash as AnchorHashValue,
  type CatchUpIncomplete,
  type CatchUpPage,
  CatchUpRequest,
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
  RecordHash,
  type RecordHash as RecordHashValue,
  signEvidenceMessage,
  type VerifiedMembership,
  verifyCatchUpIncomplete,
  verifyCatchUpPage,
  verifyOuterMessage,
} from "../../wire/index.js";
import {
  decodeStoredAnchor,
  durablePosition,
  readStoredRecord,
} from "../history/index.js";

/**
 * One run's catch-up bookkeeping: the request in flight per conversation, the
 * members that answered it as incomplete, and the successor accepted for each
 * request.
 */
export interface CatchUpState {
  readonly pendingRequests: Map<ConversationIdValue, CatchUpRequestValue>;
  readonly incompleteResponders: Map<ConversationIdValue, Set<AgentId>>;
  readonly acceptedSuccessors: Map<string, RecordHashValue | AnchorHashValue>;
}

/**
 * What catch-up needs from the run it belongs to: a recovery run, or the
 * engine's catch-up outside recovery runs. The run builds it.
 */
export interface CatchUpRun {
  readonly runtime: EngineRuntime;
  readonly state: CatchUpState;
  /** Whether the run is still current, so its requests and answers count. */
  readonly isActive: () => boolean;
  /** The run's verified membership of a conversation. */
  readonly membership: (
    conversationId: ConversationIdValue,
  ) => VerifiedMembership | undefined;
  /** Sign a packet and queue it for every member of `membership`. */
  readonly queuePacket: (
    membership: VerifiedMembership,
    packet: DirectPacket,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
  /** Every other member has attested that it holds no later history. */
  readonly onPositionReady: (
    conversationId: ConversationIdValue,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
}

/**
 * What answering a catch-up request needs. An endpoint answers inside and
 * outside its own recovery runs.
 */
export type CatchUpResponder = Pick<
  CatchUpRun,
  "runtime" | "membership" | "queuePacket"
>;

const acceptedDisposition: RouterIngressDisposition = "accepted";
const ignoredDisposition: RouterIngressDisposition = "ignored";

/**
 * Start a run's catch-up bookkeeping with nothing in flight.
 * @returns Empty catch-up state.
 */
export function makeCatchUpState(): CatchUpState {
  return {
    pendingRequests: new Map(),
    incompleteResponders: new Map(),
    acceptedSuccessors: new Map(),
  };
}

/**
 * Queue a signed catch-up request at the engine's current durable position.
 * A run that has ended, or that does not hold the conversation, such as one a
 * member created during recovery, asks for nothing.
 * @param run Run that owns the request.
 * @param conversationId Private conversation identity to reconcile.
 * @returns Completion once the run's `queuePacket` has queued the request.
 */
export const requestCertifiedHistory = (
  run: CatchUpRun,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const membership = run.membership(conversationId);
    if (!run.isActive() || membership === undefined) {
      return;
    }
    const { position } = yield* durablePosition(run.runtime, conversationId);
    if (position === undefined) {
      return yield* Effect.fail(persistenceFailure());
    }
    const knownRecordHash = yield* decodeKnownRecordHash(position);
    const knownAnchorHash = yield* decodeKnownAnchorHash(position);
    const request = yield* makeCatchUpRequest(
      run.runtime,
      membership,
      knownRecordHash,
      knownAnchorHash,
    );
    yield* Effect.sync(() => {
      run.state.pendingRequests.set(conversationId, request);
      run.state.incompleteResponders.set(conversationId, new Set<AgentId>());
    });
    yield* run.queuePacket(membership, request);
  }).pipe(Effect.withSpan("requestCertifiedHistory"));

/**
 * Answer an authenticated catch-up request with the requester's next certified
 * history item, or with an attestation that there is none.
 * @param responder Engine and membership lookup, inside or outside a run.
 * @param ingress Verified Router delivery carrying the request.
 * @param request Catch-up request from a fixed member.
 * @returns Whether the request was answered or safely ignored.
 */
export function acceptCatchUpRequest(
  responder: CatchUpResponder,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  request: CatchUpRequestValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const membership = responder.membership(request.conversationId);
  if (membership === undefined) {
    return Effect.succeed(ignoredDisposition);
  }
  const senderAgentId = ingress.message.senderAgentId;
  const requestMatchesMembership =
    senderAgentId !== responder.runtime.input.localAgentCard.agentId &&
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
    Effect.flatMap(() => respondToCatchUp(responder, membership, request)),
    Effect.as(acceptedDisposition),
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
  );
}

/**
 * Apply the certified history item a member answered the run's pending
 * request with, then ask for the next one. A page whose item does not extend
 * the conversation, or whose successor differs from the one already applied
 * for that request, does not count: it is ignored, and at most that
 * conversation's catch-up waits on the other members.
 * @param run Run that sent the request.
 * @param ingress Verified Router delivery carrying the page.
 * @param page Catch-up page from a fixed member.
 * @returns Whether the page was applied or safely ignored.
 */
export function acceptCatchUpPage(
  run: CatchUpRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  page: CatchUpPage,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const context = pendingCatchUpContext(
    run,
    page.request,
    ingress.message.senderAgentId,
  );
  if (context === undefined || !answersKnownRequest(run, context, page)) {
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
      registrySignerPublicKey: run.runtime.input.registrySignerPublicKey,
    });
    const key = requestKey(page.request);
    const successor = pageSuccessorHash(page);
    const retained = run.state.acceptedSuccessors.get(key);
    if (retained !== undefined) {
      return retained === successor ? acceptedDisposition : ignoredDisposition;
    }
    if (!sameRequest(context.pending, page.request)) {
      return ignoredDisposition;
    }
    const applied = yield* applyCatchUpPage(run.runtime, ingress, page);
    if (applied === ignoredDisposition) {
      return ignoredDisposition;
    }
    yield* Effect.sync(() => {
      run.state.acceptedSuccessors.set(key, successor);
    });
    yield* requestCertifiedHistory(run, page.request.conversationId);
    return acceptedDisposition;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
    Effect.withSpan("acceptCatchUpPage"),
  );
}

/**
 * Record a member's attestation that it holds no later history; once every
 * other member has attested, the conversation's position is ready.
 * @param run Run that sent the request.
 * @param ingress Verified Router delivery carrying the attestation.
 * @param incomplete Catch-up incomplete attestation from a fixed member.
 * @returns Whether the attestation was taken or safely ignored.
 */
export function acceptCatchUpIncomplete(
  run: CatchUpRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  incomplete: CatchUpIncomplete,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const context = pendingCatchUpContext(
    run,
    incomplete.request,
    ingress.message.senderAgentId,
  );
  if (
    context === undefined ||
    !sameRequest(context.pending, incomplete.request)
  ) {
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
        run.state,
        context.membership,
        incomplete.request.conversationId,
        ingress.message.senderAgentId,
      ),
    );
    if (!positionIsReady) {
      return acceptedDisposition;
    }
    yield* run.onPositionReady(incomplete.request.conversationId);
    return acceptedDisposition;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
    Effect.withSpan("acceptCatchUpIncomplete"),
  );
}

function respondToCatchUp(
  responder: CatchUpResponder,
  membership: VerifiedMembership,
  request: CatchUpRequestValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return responder.runtime.input.store.recover().pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((recovery) =>
      decodeCatchUpSuccessor(responder.runtime, membership, recovery, request),
    ),
    Effect.flatMap((successor) =>
      successor === undefined
        ? sendCatchUpIncomplete(responder, membership, request)
        : sendCatchUpPage(responder, membership, request, successor),
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
    return readStoredRecord(
      runtime.input.registrySignerPublicKey,
      membership,
      recovery,
      row.value,
    );
  }
  return decodeStoredAnchor(membership, row.value).pipe(
    Effect.flatMap((anchor) =>
      anchor.kind === "completed_reanchor"
        ? Effect.succeed(anchor)
        : Effect.fail(persistenceFailure()),
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
      .map((value): CatchUpSuccessorRow => ({ kind: "record", value }));
  }
  const reanchors = recovery.anchors
    .filter(
      (anchor) =>
        anchor.conversationId === request.conversationId &&
        anchor.previousAnchorHash === request.knownAnchorHash &&
        anchor.selectedRecordHash === request.knownRecordHash,
    )
    .map((value): CatchUpSuccessorRow => ({ kind: "reanchor", value }));
  const records = recovery.certifiedRecords
    .filter(
      (record) =>
        record.conversationId === request.conversationId &&
        record.previousRecordHash === request.knownRecordHash &&
        record.anchorHash === request.knownAnchorHash,
    )
    .map((value): CatchUpSuccessorRow => ({ kind: "record", value }));
  return [...reanchors, ...records];
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
  responder: CatchUpResponder,
  membership: VerifiedMembership,
  request: CatchUpRequestValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.gen(function* () {
    const attestation = yield* signCatchUpAttestation(
      responder.runtime,
      request,
      { kind: "incomplete", hash: null, hasMore: false },
    );
    yield* responder.queuePacket(membership, {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_incomplete",
      request,
      attestation,
    });
  });
}

function sendCatchUpPage(
  responder: CatchUpResponder,
  membership: VerifiedMembership,
  request: CatchUpRequestValue,
  successor: CatchUpSuccessor,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.gen(function* () {
    const hash =
      successor.item.kind === "certified_record"
        ? successor.item.actionCertifiedRecord.recordHash
        : successor.item.anchorHash;
    const attestation = yield* signCatchUpAttestation(
      responder.runtime,
      request,
      { kind: successor.item.kind, hash, hasMore: successor.hasMore },
    );
    yield* responder.queuePacket(membership, {
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

function pageSuccessorHash(
  page: CatchUpPage,
): RecordHashValue | AnchorHashValue {
  return page.item.kind === "certified_record"
    ? page.item.actionCertifiedRecord.recordHash
    : page.item.anchorHash;
}

/**
 * Apply a verified page's item. A record item goes through certification's
 * recovery path, which ignores a record that does not extend the
 * conversation, and a completed re-anchor the store refuses is ignored too.
 * @param runtime Engine whose store and conversations take the item.
 * @param ingress Verified Router delivery carrying the page.
 * @param page Verified catch-up page for the pending request.
 * @returns Whether the item was applied or ignored.
 */
function applyCatchUpPage(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  page: CatchUpPage,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  if (page.item.kind === "completed_reanchor") {
    return applyCaughtUpReanchor(runtime, page.item).pipe(
      Effect.map((applied) =>
        applied ? acceptedDisposition : ignoredDisposition,
      ),
    );
  }
  const recordIngress: RouterWorkerIngress<DecodedOuterBody> = {
    ...ingress,
    payload: { kind: "direct", packet: page.item },
  };
  return runtime.phases.acceptRecoveryIngress(runtime, recordIngress);
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}

/**
 * Make a member's caught-up completed re-anchor durable and the
 * conversation's current anchor. The store refuses one that conflicts with
 * durable state, such as a completion from an anchor and Router instance this
 * endpoint already staged another candidate for. That refusal comes from the
 * member's input, not a failed store, so the completion does not count.
 * @param runtime Engine whose store and conversation take the anchor.
 * @param completed Verified completed re-anchor from a catch-up page.
 * @returns Whether the anchor was applied; false when the store refused it.
 */
function applyCaughtUpReanchor(
  runtime: EngineRuntime,
  completed: CompletedReanchorValue,
): Effect.Effect<boolean, RouterWorkerPersistenceError> {
  return Effect.gen(function* () {
    const applied = yield* runtime.input.store
      .applyCatchUpReanchor({
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
      })
      .pipe(
        Effect.as(true),
        Effect.catchTag("EndpointStoreError", (error) =>
          isSemanticStoreRejection(error)
            ? Effect.succeed(false)
            : Effect.fail(persistenceFailure()),
        ),
      );
    if (applied) {
      yield* Effect.sync(() => {
        const conversation = runtime.conversations.get(
          completed.reanchor.conversationId,
        );
        if (conversation !== undefined) {
          conversation.currentAnchor = completed;
        }
      });
    }
    return applied;
  });
}

function recordIncompleteResponder(
  state: CatchUpState,
  membership: VerifiedMembership,
  conversationId: ConversationIdValue,
  senderAgentId: AgentId,
): boolean {
  const responders =
    state.incompleteResponders.get(conversationId) ?? new Set<AgentId>();
  responders.add(senderAgentId);
  state.incompleteResponders.set(conversationId, responders);
  const requiredRemoteResponders = membership.members.length - 1;
  if (responders.size < requiredRemoteResponders) {
    return false;
  }
  state.pendingRequests.delete(conversationId);
  state.incompleteResponders.delete(conversationId);
  return true;
}

/**
 * Whether a page answers the run's pending request, or a request it already
 * applied a successor for. Any other page is ignored before it is verified.
 * @param run Run that sent the requests.
 * @param context The run's pending request for the page's conversation.
 * @param page Catch-up page from a fixed member.
 * @returns Whether the page is worth verifying.
 */
function answersKnownRequest(
  run: CatchUpRun,
  context: Readonly<{ pending: CatchUpRequestValue }>,
  page: CatchUpPage,
): boolean {
  return (
    sameRequest(context.pending, page.request) ||
    run.state.acceptedSuccessors.has(requestKey(page.request))
  );
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
  run: CatchUpRun,
  request: CatchUpRequestValue,
  senderAgentId: AgentId,
):
  | Readonly<{ membership: VerifiedMembership; pending: CatchUpRequestValue }>
  | undefined {
  if (!run.isActive()) {
    return undefined;
  }
  const membership = run.membership(request.conversationId);
  const pending = run.state.pendingRequests.get(request.conversationId);
  if (membership === undefined || pending === undefined) {
    return undefined;
  }
  if (senderAgentId === run.runtime.input.localAgentCard.agentId) {
    return undefined;
  }
  if (memberCard(membership, senderAgentId) === undefined) {
    return undefined;
  }
  return { membership, pending };
}

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

function makeCatchUpRequest(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  knownRecordHash: RecordHashValue | null,
  knownAnchorHash: AnchorHashValue | null,
): Effect.Effect<CatchUpRequestValue, RouterWorkerPersistenceError> {
  return Schema.decodeUnknown(CatchUpRequest)({
    moltzapVersion: MOLTZAP_VERSION,
    kind: "catch_up_request",
    conversationId: membership.descriptor.conversationId,
    membershipHash: membership.hash,
    requesterAgentId: runtime.input.localAgentCard.agentId,
    knownRecordHash,
    knownAnchorHash,
  }).pipe(Effect.mapError(persistenceFailure));
}

function decodeKnownRecordHash(
  position: EndpointRecovery["positions"][number],
): Effect.Effect<RecordHashValue | null, RouterWorkerPersistenceError> {
  if (position.headRecordHash === undefined) {
    return Effect.succeed(null);
  }
  return Schema.decodeUnknown(RecordHash)(position.headRecordHash).pipe(
    Effect.mapError(persistenceFailure),
  );
}

function decodeKnownAnchorHash(
  position: EndpointRecovery["positions"][number],
): Effect.Effect<AnchorHashValue | null, RouterWorkerPersistenceError> {
  if (position.headRecordHash === undefined) {
    return Effect.succeed(null);
  }
  return Schema.decodeUnknown(AnchorHash)(position.currentAnchorHash).pipe(
    Effect.mapError(persistenceFailure),
  );
}
