/** @file Verified reconstruction of endpoint history from one store snapshot. */

import {
  type AgentId,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Effect, type ParseResult, Schema } from "effect";
import type {
  EndpointEngineInput,
  EngineActionFold,
  EngineCertifiedHead,
  EngineConversation,
  EngineRuntime,
} from "../engine-types.js";
import type {
  EndpointRecovery,
  ProtocolEvidence,
  StoredOutboundMessage,
} from "../store.js";
import {
  type ActionCertificate,
  type ActionCertifiedRecord,
  ActionCore,
  type ActionHash,
  ActionHash as ActionHashSchema,
  AnchorHash,
  type AnchorHash as AnchorHashValue,
  type CertifiedRecord,
  type ClientRepresentationError,
  compareAgentIds,
  CompletedReanchor,
  type CompletedReanchor as CompletedReanchorValue,
  ConversationId,
  type ConversationId as ConversationIdValue,
  decodeCanonical,
  GenesisAnchorBody,
  type GenesisAnchorBody as GenesisAnchorBodyValue,
  hashAnchor,
  MembershipDescriptor,
  type RecordCore,
  RecordCore as RecordCoreSchema,
  RecordHash,
  type RecordHash as RecordHashValue,
  type RouterAnchor,
  type VerifiedMembership,
  verifyActionCore,
  verifyCertifiedRecord,
  verifyCompletedReanchor,
  verifyMembershipDescriptor,
  verifyOuterMessage,
  verifyRecordCore,
} from "../representation.js";
import {
  RouterWorkerPersistenceError,
  RouterWorkerRecoveryError,
} from "../router-worker/index.js";
import { recoverFoldEvidence } from "./store-evidence.js";

type RecoveryStoreError =
  | ClientRepresentationError
  | ParseResult.ParseError
  | RouterWorkerPersistenceError;

/** Complete process-local projections recovered before protocol work resumes. */
interface RecoveredEngineState {
  readonly conversations: Map<ConversationIdValue, EngineConversation>;
  readonly actionFolds: Map<ActionHash, EngineActionFold>;
  readonly recordFolds: Map<RecordHashValue, EngineActionFold>;
  readonly completedPostIds: Set<string>;
  readonly postIntents: ReadonlyArray<EndpointRecovery["postIntents"][number]>;
  readonly outboundMessages: readonly StoredOutboundMessage[];
}

/**
 * Rebuild only state whose hashes, signatures, and cross-fields still verify.
 * @param input Engine dependencies used to verify persisted representation.
 * @param recovery Complete store snapshot captured before engine startup.
 * @returns Verified conversations, folds, and durable post intents.
 */
export const recoverEngineState = (
  input: EndpointEngineInput,
  recovery: EndpointRecovery,
): Effect.Effect<RecoveredEngineState, RecoveryStoreError> =>
  Effect.gen(function* () {
    const verifiedMemberships = yield* recoverEngineMemberships(
      input,
      recovery,
    );
    const anchors = yield* recoverEngineAnchors(recovery, verifiedMemberships);
    const conversations = yield* recoverConversations(
      recovery,
      verifiedMemberships,
      anchors.current,
    );
    const actionFolds = yield* recoverActionFolds(
      recovery,
      conversations,
      anchors.byHash,
    );
    const recordFolds = yield* recoverStagedFolds(input, recovery, actionFolds);
    const outboundMessages = yield* verifyStoredOutbounds(
      input,
      recovery.outboundMessages,
      verifiedMemberships,
    );
    yield* recoverFoldEvidence(recovery, actionFolds, recordFolds);
    yield* recoverCertifiedFolds({
      input,
      recovery,
      conversations,
      anchorsByHash: anchors.byHash,
      actionFolds,
      recordFolds,
    });
    return {
      conversations,
      actionFolds,
      recordFolds,
      completedPostIds: completedPostIds(recovery),
      postIntents: recovery.postIntents,
      outboundMessages,
    };
  }).pipe(Effect.withSpan("recoverEngineState"));

/**
 * Reconstruct one complete certified record from separately retained evidence.
 * @param input Engine dependencies used for Registry signature verification.
 * @param stored Durable record core and signer-attributed evidence rows.
 * @param routerAnchor Verified anchor named by the durable record core.
 * @returns The complete record after all hashes and store projections match.
 */
export const recordFromStore = (
  input: EndpointEngineInput,
  stored: EndpointRecovery["certifiedRecords"][number],
  routerAnchor: EngineConversation["currentAnchor"],
): Effect.Effect<CertifiedRecord, RecoveryStoreError> =>
  assembleStoredRecord(stored, routerAnchor).pipe(
    Effect.flatMap((record) =>
      verifyCertifiedRecord({
        record,
        registrySignerPublicKey: input.registrySignerPublicKey,
      }).pipe(
        Effect.flatMap((membership) =>
          storedRecordMatches(stored, record, membership)
            ? Effect.succeed(record)
            : Effect.fail(persistenceFailure()),
        ),
      ),
    ),
    Effect.withSpan("recordFromStore"),
  );

/**
 * Decode and verify one durable genesis or completed re-anchor row.
 * @param membership Fixed membership that owns the anchor.
 * @param stored Durable anchor row and canonical representation.
 * @returns A verified anchor usable for record reconstruction.
 */
export function decodeStoredAnchor(
  membership: VerifiedMembership,
  stored: EndpointRecovery["anchors"][number],
): Effect.Effect<
  EngineConversation["currentAnchor"],
  RouterWorkerPersistenceError
> {
  const decoded =
    stored.previousAnchorHash === undefined
      ? decodeStoredGenesis(membership, stored)
      : decodeStoredReanchor(membership, stored);
  return decoded.pipe(Effect.withSpan("decodeStoredAnchor"));
}

/**
 * Verify every retained current outer envelope before Router resumption.
 * @param input Engine identity and signature-verification dependencies.
 * @param outbounds Exact pending rows recovered in durable insertion order.
 * @param memberships Verified membership for each retained conversation.
 * @returns The unchanged rows after canonical bytes and attribution verify.
 */
export function verifyStoredOutbounds(
  input: EndpointEngineInput,
  outbounds: readonly StoredOutboundMessage[],
  memberships: ReadonlyMap<ConversationIdValue, VerifiedMembership>,
): Effect.Effect<readonly StoredOutboundMessage[], RecoveryStoreError> {
  return Effect.forEach(
    outbounds,
    (outbound) => verifyStoredOutbound(input, memberships, outbound),
    { concurrency: 1 },
  );
}

/**
 * Verify that every recovered record and anchor forms one gap-free history.
 * @param runtime Engine used for Registry and conversation verification.
 * @param recovery Complete store snapshot to verify.
 * @param memberships Verified fixed memberships keyed by conversation.
 * @returns Completion only when every retained history is complete and unique.
 */
export function verifyRecoveredHistory(
  runtime: EngineRuntime,
  recovery: EndpointRecovery,
  memberships: Map<ConversationIdValue, VerifiedMembership>,
): Effect.Effect<void, RouterWorkerRecoveryError> {
  if (!recoveryOnlyContainsMemberships(recovery, memberships)) {
    return Effect.fail(recoveryFailure());
  }
  return Effect.forEach(
    memberships.values(),
    (membership) => verifyConversationHistory(runtime, recovery, membership),
    { concurrency: 1, discard: true },
  ).pipe(Effect.withSpan("verifyRecoveredHistory"));
}

function recoveryOnlyContainsMemberships(
  recovery: EndpointRecovery,
  memberships: ReadonlyMap<ConversationIdValue, VerifiedMembership>,
): boolean {
  const known = new Set<string>(memberships.keys());
  const validCollections = [
    recovery.positions.length === memberships.size,
    recovery.anchors.every((anchor) => known.has(anchor.conversationId)),
    recovery.certifiedRecords.every((record) =>
      known.has(record.conversationId),
    ),
  ];
  return validCollections.every((valid) => valid);
}

interface HistoryCursor {
  readonly currentAnchor: EngineConversation["currentAnchor"];
  readonly currentAnchorHash: string;
  readonly currentRecordHash: string | null;
  readonly anchorIndex: number;
}

interface ConversationHistory {
  readonly position: EndpointRecovery["positions"][number];
  readonly anchors: ReadonlyArray<EndpointRecovery["anchors"][number]>;
  readonly records: ReadonlyArray<EndpointRecovery["certifiedRecords"][number]>;
  readonly initial: HistoryCursor;
}

function verifyConversationHistory(
  runtime: EngineRuntime,
  recovery: EndpointRecovery,
  membership: VerifiedMembership,
): Effect.Effect<void, RouterWorkerRecoveryError> {
  return conversationHistory(recovery, membership).pipe(
    Effect.flatMap((history) =>
      verifyHistoryRecords({
        runtime,
        membership,
        history,
        recordIndex: 0,
        cursor: history.initial,
      }),
    ),
    Effect.flatMap((result) =>
      historyCursorMatchesPosition(result.history, result.cursor)
        ? Effect.void
        : Effect.fail(recoveryFailure()),
    ),
    Effect.mapError(recoveryFailure),
  );
}

function conversationHistory(
  recovery: EndpointRecovery,
  membership: VerifiedMembership,
): Effect.Effect<ConversationHistory, RouterWorkerRecoveryError> {
  const conversationId = membership.descriptor.conversationId;
  const positions = recovery.positions.filter(
    (candidate) => candidate.conversationId === conversationId,
  );
  const anchors = recovery.anchors.filter(
    (candidate) => candidate.conversationId === conversationId,
  );
  const position = positions[0];
  const firstAnchor = anchors[0];
  if (
    position === undefined ||
    firstAnchor === undefined ||
    !validHistoryFoundation(positions, position, firstAnchor, membership)
  ) {
    return Effect.fail(recoveryFailure());
  }
  return decodeStoredAnchor(membership, firstAnchor).pipe(
    Effect.map((currentAnchor) => ({
      position,
      anchors,
      records: recovery.certifiedRecords.filter(
        (candidate) => candidate.conversationId === conversationId,
      ),
      initial: {
        currentAnchor,
        currentAnchorHash: firstAnchor.anchorHash,
        currentRecordHash: null,
        anchorIndex: 1,
      },
    })),
    Effect.mapError(recoveryFailure),
  );
}

function validHistoryFoundation(
  positions: ReadonlyArray<EndpointRecovery["positions"][number]>,
  position: EndpointRecovery["positions"][number],
  firstAnchor: EndpointRecovery["anchors"][number],
  membership: VerifiedMembership,
): boolean {
  return [
    positions.length === 1,
    position.membershipHash === membership.hash,
    firstAnchor.previousAnchorHash === undefined,
  ].every((matches) => matches);
}

interface VerifiedHistoryResult {
  readonly history: ConversationHistory;
  readonly cursor: HistoryCursor;
}

interface HistoryVerificationInput {
  readonly runtime: EngineRuntime;
  readonly membership: VerifiedMembership;
  readonly history: ConversationHistory;
  readonly recordIndex: number;
  readonly cursor: HistoryCursor;
}

function verifyHistoryRecords(
  input: HistoryVerificationInput,
): Effect.Effect<VerifiedHistoryResult, RouterWorkerRecoveryError> {
  const { cursor, history, membership, recordIndex, runtime } = input;
  const stored = history.records[recordIndex];
  if (stored === undefined) {
    return Effect.succeed({ history, cursor });
  }
  if (!recordExtendsCursor(stored, membership, cursor)) {
    return Effect.fail(recoveryFailure());
  }
  return recordFromStore(runtime.input, stored, cursor.currentAnchor).pipe(
    Effect.mapError(recoveryFailure),
    Effect.flatMap(() =>
      advanceHistoryAnchors(
        membership,
        history.anchors,
        populatedCursor(cursor, stored.recordHash),
      ),
    ),
    Effect.flatMap((nextCursor) =>
      verifyHistoryRecords({
        runtime,
        membership,
        history,
        recordIndex: recordIndex + 1,
        cursor: nextCursor,
      }),
    ),
  );
}

function recordExtendsCursor(
  stored: EndpointRecovery["certifiedRecords"][number],
  membership: VerifiedMembership,
  cursor: HistoryCursor,
): boolean {
  const previous = stored.previousRecordHash ?? null;
  return [
    stored.membershipHash === membership.hash,
    previous === cursor.currentRecordHash,
    stored.anchorHash === cursor.currentAnchorHash,
  ].every((matches) => matches);
}

function populatedCursor(
  cursor: HistoryCursor,
  recordHash: string,
): HistoryCursor {
  return { ...cursor, currentRecordHash: recordHash };
}

function advanceHistoryAnchors(
  membership: VerifiedMembership,
  anchors: ReadonlyArray<EndpointRecovery["anchors"][number]>,
  cursor: HistoryCursor,
): Effect.Effect<HistoryCursor, RouterWorkerRecoveryError> {
  const nextAnchor = anchors[cursor.anchorIndex];
  if (nextAnchor === undefined || !anchorExtendsCursor(nextAnchor, cursor)) {
    return Effect.succeed(cursor);
  }
  return decodeStoredAnchor(membership, nextAnchor).pipe(
    Effect.mapError(recoveryFailure),
    Effect.flatMap((currentAnchor) =>
      advanceHistoryAnchors(membership, anchors, {
        currentAnchor,
        currentAnchorHash: nextAnchor.anchorHash,
        currentRecordHash: cursor.currentRecordHash,
        anchorIndex: cursor.anchorIndex + 1,
      }),
    ),
  );
}

function anchorExtendsCursor(
  anchor: EndpointRecovery["anchors"][number],
  cursor: HistoryCursor,
): boolean {
  return (
    anchor.previousAnchorHash === cursor.currentAnchorHash &&
    anchor.selectedRecordHash === cursor.currentRecordHash
  );
}

function historyCursorMatchesPosition(
  history: ConversationHistory,
  cursor: HistoryCursor,
): boolean {
  return [
    cursor.anchorIndex === history.anchors.length,
    (history.position.headRecordHash ?? null) === cursor.currentRecordHash,
    history.position.currentAnchorHash === cursor.currentAnchorHash,
  ].every((matches) => matches);
}

function verifyStoredOutbound(
  input: EndpointEngineInput,
  memberships: ReadonlyMap<ConversationIdValue, VerifiedMembership>,
  outbound: StoredOutboundMessage,
): Effect.Effect<StoredOutboundMessage, RecoveryStoreError> {
  return Effect.gen(function* () {
    const conversationId = yield* Schema.decodeUnknown(ConversationId)(
      outbound.conversationId,
    );
    const membership = memberships.get(conversationId);
    if (membership === undefined) {
      return yield* Effect.fail(persistenceFailure());
    }
    const message = yield* decodeCanonical(
      SignedMessage,
      outbound.canonicalSignedMessage,
    );
    if (
      message.messageId !== outbound.messageId ||
      message.senderAgentId !== input.localAgentCard.agentId
    ) {
      return yield* Effect.fail(persistenceFailure());
    }
    yield* verifyOuterMessage({ message, membership });
    return outbound;
  });
}

function assembleStoredRecord(
  stored: EndpointRecovery["certifiedRecords"][number],
  routerAnchor: EngineConversation["currentAnchor"],
): Effect.Effect<CertifiedRecord, RecoveryStoreError> {
  return Effect.gen(function* () {
    const recordCore = yield* decodeCanonical(
      RecordCoreSchema,
      stored.canonicalRecordCore,
    );
    const signatures = yield* restoreEvidence(stored.actionEvidence);
    const votes = yield* restoreEvidence(stored.durabilityEvidence);
    const recordHash = yield* Schema.decodeUnknown(RecordHash)(
      stored.recordHash,
    );
    const actionCertifiedRecord: ActionCertifiedRecord = {
      moltzapVersion: recordCore.moltzapVersion,
      kind: "action_certified_record",
      recordHash,
      recordCore,
      routerAnchor,
      actionCertificate: {
        moltzapVersion: recordCore.moltzapVersion,
        kind: "action_certificate",
        actionHash: recordCore.actionHash,
        signatures,
      },
    };
    return {
      moltzapVersion: recordCore.moltzapVersion,
      kind: "certified_record",
      actionCertifiedRecord,
      durabilityCertificate: {
        moltzapVersion: recordCore.moltzapVersion,
        kind: "durability_certificate",
        recordHash,
        votes,
      },
    };
  });
}

function restoreEvidence(
  rows: readonly ProtocolEvidence[],
): Effect.Effect<ActionCertificate["signatures"], RecoveryStoreError> {
  return decodeEvidence(rows).pipe(
    Effect.flatMap((messages) =>
      Effect.forEach(
        messages,
        (message) => Schema.encode(SignedMessage)(message),
        { concurrency: 1 },
      ),
    ),
    Effect.flatMap(requireNonEmpty),
  );
}

function decodeEvidence(
  rows: readonly ProtocolEvidence[],
): Effect.Effect<readonly SignedMessageValue[], RecoveryStoreError> {
  return Effect.forEach(
    rows,
    (row) => decodeCanonical(SignedMessage, row.canonicalEvidence),
    { concurrency: 1 },
  ).pipe(
    Effect.map((messages) =>
      // SQLite orders encoded evidence keys, while certificates require
      // decoded AgentId byte order.
      [...messages].sort((left, right) =>
        compareAgentIds(left.senderAgentId, right.senderAgentId),
      ),
    ),
  );
}

function requireNonEmpty<Value>(
  values: readonly Value[],
): Effect.Effect<readonly [Value, ...Value[]], RouterWorkerPersistenceError> {
  const first = values[0];
  if (first === undefined) {
    return Effect.fail(persistenceFailure());
  }
  return Effect.succeed([first, ...values.slice(1)]);
}

function storedRecordMatches(
  stored: EndpointRecovery["certifiedRecords"][number],
  record: CertifiedRecord,
  membership: VerifiedMembership,
): boolean {
  const core = record.actionCertifiedRecord.recordCore;
  const projectionMatches = [
    stored.conversationId === membership.descriptor.conversationId,
    stored.membershipHash === membership.hash,
    stored.previousRecordHash === previousRecordHash(core.action),
    stored.anchorHash === core.anchorHash,
    stored.actionHash === core.actionHash,
    stored.authorAgentId === core.action.postIntent.authorAgentId,
    stored.postId === core.action.postIntent.postId,
  ];
  return projectionMatches.every((matches) => matches);
}

function recoverEngineMemberships(
  input: EndpointEngineInput,
  recovery: EndpointRecovery,
) {
  return Effect.forEach(
    recovery.memberships,
    (stored) =>
      decodeCanonical(MembershipDescriptor, stored.canonicalMembership).pipe(
        Effect.flatMap((descriptor) =>
          verifyMembershipDescriptor(descriptor, input.registrySignerPublicKey),
        ),
        Effect.flatMap((membership) => {
          if (
            stored.conversationId !== membership.descriptor.conversationId ||
            stored.membershipHash !== membership.hash
          ) {
            return Effect.fail(persistenceFailure());
          }
          const entry: readonly [ConversationIdValue, VerifiedMembership] = [
            membership.descriptor.conversationId,
            membership,
          ];
          return Effect.succeed(entry);
        }),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map(
      (entries) => new Map<ConversationIdValue, VerifiedMembership>(entries),
    ),
  );
}

interface RecoveredAnchors {
  readonly current: Map<
    ConversationIdValue,
    EngineConversation["currentAnchor"]
  >;
  readonly byHash: Map<AnchorHashValue, EngineConversation["currentAnchor"]>;
}

function recoverEngineAnchors(
  recovery: EndpointRecovery,
  memberships: ReadonlyMap<ConversationIdValue, VerifiedMembership>,
): Effect.Effect<RecoveredAnchors, RecoveryStoreError> {
  return Effect.forEach(
    recovery.anchors,
    (stored) =>
      Schema.decodeUnknown(ConversationId)(stored.conversationId).pipe(
        Effect.flatMap((conversationId) => {
          const membership = memberships.get(conversationId);
          if (membership === undefined) {
            return Effect.fail(persistenceFailure());
          }
          return decodeStoredAnchor(membership, stored).pipe(
            Effect.zipWith(
              Schema.decodeUnknown(AnchorHash)(stored.anchorHash),
              (anchor, anchorHash) => ({
                stored,
                conversationId,
                anchorHash,
                anchor,
              }),
            ),
          );
        }),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((entries) => {
      const current = new Map<
        ConversationIdValue,
        EngineConversation["currentAnchor"]
      >();
      const byHash = new Map<
        AnchorHashValue,
        EngineConversation["currentAnchor"]
      >();
      for (const { stored, conversationId, anchorHash, anchor } of entries) {
        byHash.set(anchorHash, anchor);
        if (positionUsesAnchor(recovery, stored)) {
          current.set(conversationId, anchor);
        }
      }
      return { current, byHash };
    }),
  );
}

function positionUsesAnchor(
  recovery: EndpointRecovery,
  stored: EndpointRecovery["anchors"][number],
): boolean {
  return recovery.positions.some(
    (position) =>
      position.conversationId === stored.conversationId &&
      position.currentAnchorHash === stored.anchorHash,
  );
}

function recoverConversations(
  recovery: EndpointRecovery,
  memberships: ReadonlyMap<ConversationIdValue, VerifiedMembership>,
  anchors: ReadonlyMap<
    ConversationIdValue,
    EngineConversation["currentAnchor"]
  >,
) {
  return Effect.forEach(
    recovery.positions,
    (position) =>
      Schema.decodeUnknown(ConversationId)(position.conversationId).pipe(
        Effect.flatMap((conversationId) => {
          const membership = memberships.get(conversationId);
          const anchor = anchors.get(conversationId);
          if (membership === undefined || anchor === undefined) {
            return Effect.fail(persistenceFailure());
          }
          const conversation: EngineConversation = {
            conversationId,
            membership,
            currentAnchor: anchor,
          };
          const entry: readonly [ConversationIdValue, EngineConversation] = [
            conversationId,
            conversation,
          ];
          return Effect.succeed(entry);
        }),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map(
      (entries) => new Map<ConversationIdValue, EngineConversation>(entries),
    ),
  );
}

function recoverActionFolds(
  recovery: EndpointRecovery,
  conversations: ReadonlyMap<ConversationIdValue, EngineConversation>,
  anchorsByHash: ReadonlyMap<AnchorHashValue, RouterAnchor>,
) {
  return Effect.forEach(
    recovery.proposalLocks,
    (lock) =>
      Effect.gen(function* () {
        const conversationId = yield* Schema.decodeUnknown(ConversationId)(
          lock.conversationId,
        );
        const conversation = conversations.get(conversationId);
        if (conversation === undefined) {
          return yield* Effect.fail(persistenceFailure());
        }
        const action = yield* decodeCanonical(
          ActionCore,
          lock.canonicalActionCore,
        );
        const actionHash = yield* Schema.decodeUnknown(ActionHashSchema)(
          lock.actionHash,
        );
        const verified = yield* verifyActionCore({
          action,
          membership: conversation.membership,
        });
        if (verified.actionHash !== actionHash) {
          return yield* Effect.fail(persistenceFailure());
        }
        const routerAnchor = yield* recoveredActionAnchor(
          verified.anchorHash,
          anchorsByHash,
        );
        const entry: readonly [ActionHash, EngineActionFold] = [
          actionHash,
          makeFold(conversation, action, actionHash, routerAnchor),
        ];
        return entry;
      }),
    { concurrency: 1 },
  ).pipe(
    Effect.map((entries) => new Map<ActionHash, EngineActionFold>(entries)),
  );
}

function recoveredActionAnchor(
  anchorHash: AnchorHashValue,
  anchorsByHash: ReadonlyMap<AnchorHashValue, RouterAnchor>,
): Effect.Effect<RouterAnchor, RouterWorkerPersistenceError> {
  const anchor = anchorsByHash.get(anchorHash);
  return anchor === undefined
    ? Effect.fail(persistenceFailure())
    : Effect.succeed(anchor);
}

function recoverStagedFolds(
  input: EndpointEngineInput,
  recovery: EndpointRecovery,
  actionFolds: Map<ActionHash, EngineActionFold>,
): Effect.Effect<Map<RecordHashValue, EngineActionFold>, RecoveryStoreError> {
  return Effect.forEach(
    recovery.stagedRecords,
    (staged) =>
      Effect.gen(function* () {
        const actionHash = yield* Schema.decodeUnknown(ActionHashSchema)(
          staged.actionHash,
        );
        const recordHash = yield* Schema.decodeUnknown(RecordHash)(
          staged.recordHash,
        );
        const fold = actionFolds.get(actionHash);
        const recordCore = yield* decodeCanonical(
          RecordCoreSchema,
          staged.canonicalRecordCore,
        );
        const verified = yield* verifyRecordCore({
          recordCore,
          registrySignerPublicKey: input.registrySignerPublicKey,
        });
        if (
          fold === undefined ||
          !stagedRecordMatches(staged, fold, recordCore, verified.recordHash)
        ) {
          return yield* Effect.fail(persistenceFailure());
        }
        yield* Effect.sync(() => {
          fold.recordHash = recordHash;
        });
        const entry: readonly [RecordHashValue, EngineActionFold] = [
          recordHash,
          fold,
        ];
        return entry;
      }),
    { concurrency: 1 },
  ).pipe(
    Effect.map(
      (entries) => new Map<RecordHashValue, EngineActionFold>(entries),
    ),
  );
}

function stagedRecordMatches(
  staged: EndpointRecovery["stagedRecords"][number],
  fold: EngineActionFold,
  recordCore: RecordCore,
  recordHash: RecordHashValue,
): boolean {
  const conversation = fold.conversation;
  return [
    staged.conversationId === conversation.conversationId,
    staged.membershipHash === conversation.membership.hash,
    staged.previousRecordHash === previousRecordHash(recordCore.action),
    staged.anchorHash === recordCore.anchorHash,
    staged.actionHash === fold.actionHash,
    recordCore.actionHash === fold.actionHash,
    staged.authorAgentId === recordCore.action.postIntent.authorAgentId,
    staged.postId === recordCore.action.postIntent.postId,
    staged.recordHash === recordHash,
  ].every((matches) => matches);
}

function previousRecordHash(
  action: RecordCore["action"],
): RecordHashValue | undefined {
  if (action.previousRecordHash === null) {
    return undefined;
  }
  return action.previousRecordHash;
}

interface CertifiedFoldRecoveryInput {
  readonly input: EndpointEngineInput;
  readonly recovery: EndpointRecovery;
  readonly conversations: Map<ConversationIdValue, EngineConversation>;
  readonly anchorsByHash: ReadonlyMap<
    AnchorHashValue,
    EngineConversation["currentAnchor"]
  >;
  readonly actionFolds: Map<ActionHash, EngineActionFold>;
  readonly recordFolds: Map<RecordHashValue, EngineActionFold>;
}

function recoverCertifiedFolds(
  input: CertifiedFoldRecoveryInput,
): Effect.Effect<void, RecoveryStoreError> {
  return Effect.forEach(
    input.recovery.certifiedRecords,
    (stored) => recoverCertifiedFold(input, stored),
    { concurrency: 1, discard: true },
  );
}

function recoverCertifiedFold(
  input: CertifiedFoldRecoveryInput,
  stored: EndpointRecovery["certifiedRecords"][number],
): Effect.Effect<void, RecoveryStoreError> {
  return Effect.gen(function* () {
    const context = yield* certifiedFoldContext(input, stored);
    const record = yield* recordFromStore(
      input.input,
      stored,
      context.routerAnchor,
    );
    const actionHash = yield* Schema.decodeUnknown(ActionHashSchema)(
      stored.actionHash,
    );
    const actionEvidence = yield* decodeEvidence(stored.actionEvidence);
    const durabilityEvidence = yield* decodeEvidence(stored.durabilityEvidence);
    yield* Effect.sync(() => {
      const fold =
        input.actionFolds.get(actionHash) ??
        makeFold(
          context.conversation,
          record.actionCertifiedRecord.recordCore.action,
          record.actionCertifiedRecord.recordCore.actionHash,
          context.routerAnchor,
        );
      input.actionFolds.set(actionHash, fold);
      completeRecoveredFold(fold, record, actionEvidence, durabilityEvidence);
      input.recordFolds.set(record.actionCertifiedRecord.recordHash, fold);
      context.conversation.head = certifiedHead(record);
    });
  });
}

function certifiedFoldContext(
  input: CertifiedFoldRecoveryInput,
  stored: EndpointRecovery["certifiedRecords"][number],
) {
  return Effect.all({
    conversationId: Schema.decodeUnknown(ConversationId)(stored.conversationId),
    anchorHash: Schema.decodeUnknown(AnchorHash)(stored.anchorHash),
  }).pipe(
    Effect.flatMap(({ conversationId, anchorHash }) => {
      const conversation = input.conversations.get(conversationId);
      const routerAnchor = input.anchorsByHash.get(anchorHash);
      if (conversation === undefined || routerAnchor === undefined) {
        return Effect.fail(persistenceFailure());
      }
      return Effect.succeed({ conversation, routerAnchor });
    }),
  );
}

function completeRecoveredFold(
  fold: EngineActionFold,
  record: CertifiedRecord,
  actionEvidence: readonly SignedMessageValue[],
  durabilityEvidence: readonly SignedMessageValue[],
): void {
  for (const message of actionEvidence) {
    fold.actionEvidence.set(message.senderAgentId, message);
  }
  for (const message of durabilityEvidence) {
    fold.durabilityEvidence.set(message.senderAgentId, message);
  }
  fold.recordHash = record.actionCertifiedRecord.recordHash;
  fold.certifiedRecord = record;
  fold.actionCertifiedRecordQueued = true;
  fold.certifiedRecordQueued = true;
}

function certifiedHead(record: CertifiedRecord): EngineCertifiedHead {
  return {
    recordHash: record.actionCertifiedRecord.recordHash,
    record,
  };
}

function makeFold(
  conversation: EngineConversation,
  action: RecordCore["action"],
  actionHash: RecordCore["actionHash"],
  routerAnchor: RouterAnchor,
): EngineActionFold {
  return {
    conversation,
    action,
    actionHash,
    routerAnchor,
    actionEvidence: new Map<AgentId, SignedMessageValue>(),
    durabilityEvidence: new Map<AgentId, SignedMessageValue>(),
    localActionEvidenceQueued: false,
    actionCertifiedRecordQueued: false,
    localDurabilityEvidenceQueued: false,
    certifiedRecordQueued: false,
  };
}

function completedPostIds(recovery: EndpointRecovery): Set<string> {
  return new Set<string>(
    recovery.postIntents
      .filter((intent) => intent.completedRecordHash !== undefined)
      .map((intent) => intent.postId),
  );
}

function decodeStoredGenesis(
  membership: VerifiedMembership,
  stored: EndpointRecovery["anchors"][number],
): Effect.Effect<
  EngineConversation["currentAnchor"],
  RouterWorkerPersistenceError
> {
  return decodeCanonical(GenesisAnchorBody, stored.canonicalAnchor).pipe(
    Effect.flatMap((anchor) =>
      hashAnchor(anchor).pipe(
        Effect.flatMap((anchorHash) =>
          storedGenesisMatches(membership, stored, anchor, anchorHash)
            ? Effect.succeed(anchor)
            : Effect.fail(persistenceFailure()),
        ),
      ),
    ),
    Effect.mapError(persistenceFailure),
  );
}

function storedGenesisMatches(
  membership: VerifiedMembership,
  stored: EndpointRecovery["anchors"][number],
  anchor: GenesisAnchorBodyValue,
  anchorHash: AnchorHashValue,
): boolean {
  return [
    anchor.conversationId === stored.conversationId,
    anchor.membershipHash === membership.hash,
    stored.selectedRecordHash === undefined,
    anchorHash === stored.anchorHash,
  ].every((matches) => matches);
}

function decodeStoredReanchor(
  membership: VerifiedMembership,
  stored: EndpointRecovery["anchors"][number],
): Effect.Effect<
  EngineConversation["currentAnchor"],
  RouterWorkerPersistenceError
> {
  return decodeCanonical(CompletedReanchor, stored.canonicalAnchor).pipe(
    Effect.flatMap((completed) =>
      verifyCompletedReanchor({ completed, membership }).pipe(
        Effect.flatMap((anchorHash) =>
          storedReanchorMatches(stored, completed, anchorHash)
            ? Effect.succeed(completed)
            : Effect.fail(persistenceFailure()),
        ),
      ),
    ),
    Effect.mapError(persistenceFailure),
  );
}

function storedReanchorMatches(
  stored: EndpointRecovery["anchors"][number],
  completed: CompletedReanchorValue,
  anchorHash: AnchorHashValue,
): boolean {
  return [
    anchorHash === stored.anchorHash,
    completed.reanchor.previousAnchorHash === stored.previousAnchorHash,
    completed.reanchor.selectedRecordHash === stored.selectedRecordHash,
  ].every((matches) => matches);
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}

function recoveryFailure(): RouterWorkerRecoveryError {
  return new RouterWorkerRecoveryError();
}
