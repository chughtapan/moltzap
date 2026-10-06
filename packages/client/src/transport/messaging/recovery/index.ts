/**
 * @file Recovery run lifecycle: one authenticated catch-up and re-anchor run
 * per Router discontinuity, its ingress dispatch, the per-conversation fences
 * and catch-up retries it holds, and the ports its catch-up and re-anchor use.
 */

import type { SignedMessage } from "@moltzap/identity";
import {
  Duration,
  Effect,
  ExecutionStrategy,
  Exit,
  FiberMap,
  Schedule,
  Scope,
} from "effect";
import type {
  EndpointRecovery,
  StoredOutboundMessage,
} from "../../../store/index.js";
import type { EngineRuntime } from "../runtime/index.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
  type RouterWorkerRecovery,
  RouterWorkerRecoveryError,
} from "../../router/index.js";
import {
  type ConversationId as ConversationIdValue,
  decodeCanonical,
  type DecodedOuterBody,
  type DirectPacket,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  memberCard,
  type VerifiedMembership,
} from "../../wire/index.js";
import {
  durableRouterInstanceId,
  verifyRecoveredHistory,
  verifyStoredMemberships,
  verifyStoredOutbounds,
} from "../history/index.js";
import {
  acceptCompletedReanchor,
  acceptReanchorVote,
  positionReady as reanchorPositionReady,
  type ReanchorRun,
  startReanchorRun,
} from "../reanchor/index.js";
import {
  completeRecoveryBarrier,
  currentRecoveryBarrier,
  fenceConversation,
  pendingRecoveryFence,
  releaseConversation,
} from "./barrier.js";
import {
  acceptCatchUpIncomplete,
  acceptCatchUpPage,
  acceptCatchUpRequest,
  type CatchUpResponder,
  type CatchUpRun,
  makeCatchUpState,
  requestCertifiedHistory,
  resendCertifiedHistoryRequest,
  sentByOtherMember,
} from "./catch-up.js";

/**
 * The recovery fences the engine installs at a discontinuity and a send waits
 * behind.
 */
export { installRecoveryBarrier, pendingRecoveryFence } from "./barrier.js";

/**
 * Delay before a conversation's first catch-up retry. One second is well past
 * a Router round trip, so a retry follows a request that went unanswered
 * rather than racing its answers.
 */
const catchUpRetryBase = Duration.seconds(1);

/**
 * Catch-up retries after a conversation's first request. With the doubling
 * delay, eight retries span about four minutes (1 s + 2 s + ... + 128 s,
 * each jittered). After the last one the conversation stays paused until a
 * member's traffic for it, a local post into it, the Router worker
 * reattaching, or the next recovery run arms it again.
 */
export const catchUpRetryAttempts = 8;

/**
 * A conversation's catch-up retries: doubling jittered delays, at most
 * {@link catchUpRetryAttempts} of them. Recovering the conversation removes
 * its retries from the run, which ends them early.
 */
const catchUpRetrySchedule = Schedule.exponential(catchUpRetryBase).pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(catchUpRetryAttempts)),
);

/**
 * One authenticated recovery run. It holds each conversation that has not
 * recovered behind its own fence; the others carry on. Its catch-up and
 * re-anchor reach it only through the ports built here.
 */
interface RecoveryRun {
  readonly runtime: EngineRuntime;
  readonly recovery: RouterWorkerRecovery;
  /**
   * Conversations whose durable anchor names a Router instance other than the
   * recovery anchor. Only these re-anchor; the rest recover by catch-up alone.
   */
  readonly reanchoring: ReadonlySet<string>;
  readonly memberships: Map<ConversationIdValue, VerifiedMembership>;
  /**
   * Outbox ids of each conversation's retained envelopes, resumed and dropped
   * once it recovers.
   */
  readonly retainedOutbounds: Map<string, readonly string[]>;
  readonly completedConversations: Set<ConversationIdValue>;
  /**
   * The run's lifetime inside the engine's. Closing it ends every catch-up
   * retry the run started.
   */
  readonly scope: Scope.CloseableScope;
  /**
   * Each conversation's running catch-up retries. A pending conversation
   * missing here has used up its retries and waits for traffic to re-arm it.
   */
  readonly retries: FiberMap.FiberMap<ConversationIdValue>;
  readonly catchUp: CatchUpRun;
  readonly reanchor: ReanchorRun;
}

const activeRuns = new WeakMap<EngineRuntime, RecoveryRun>();

const ignoredDisposition: RouterIngressDisposition = "ignored";

/**
 * Accept one verified Router delivery, whether the Router worker polls it
 * while it recovers or while it is active. Catch-up and re-anchor traffic
 * goes to the recovery run, and a member's catch-up request is always
 * answered. Every other value goes to the protocol phases unless its
 * conversation is fenced: while a discontinuity has no recovery run, every
 * conversation is, and afterwards each one the run has not recovered. A
 * fenced conversation's certified records are applied through recovery, and
 * its action traffic is ignored. A member's traffic for a fenced conversation
 * whose catch-up retries ran out arms them again.
 * @param runtime Engine whose state receives the ingress.
 * @param ingress Verified Router delivery and decoded private payload.
 * @returns Whether the payload was accepted or safely ignored.
 */
export function acceptEngineIngressWithRecovery(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const { payload } = ingress;
  return (
    payload.kind === "evidence"
      ? acceptEvidence(runtime, ingress, payload.message)
      : acceptPacket(runtime, ingress, payload.packet)
  ).pipe(Effect.withSpan("acceptEngineIngressWithRecovery"));
}

/**
 * Start catch-up again for paused conversations: those the recovery run
 * still holds whose capped retries ran out. A local send to such a
 * conversation arms its catch-up, and a Router worker that reattaches after
 * an outage arms every one, so a paused conversation always has a way back to
 * recovery. The requests go out on a fiber in the run's scope, so neither the
 * send nor the reattaching worker waits on the store reads they take. A store
 * failure while asking ends the new retries the same way.
 * @param runtime Engine whose recovery run holds the conversations.
 * @param conversationId The one conversation to arm; every paused
 *     conversation when omitted.
 * @returns Completion once the arming fiber is started.
 */
export function rearmPausedCatchUp(
  runtime: EngineRuntime,
  conversationId?: ConversationIdValue,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const run = activeRuns.get(runtime);
    if (run === undefined) {
      return Effect.void;
    }
    const conversations =
      conversationId === undefined
        ? [...run.memberships.keys()]
        : [conversationId];
    return Effect.forEach(
      conversations,
      (paused) => rearmIfPaused(runtime, paused),
      { concurrency: 1, discard: true },
    ).pipe(
      Effect.catchAll(() =>
        Effect.logWarning(
          "Catch-up was not armed again: the endpoint store could not be read",
        ),
      ),
      Effect.withSpan("rearmPausedCatchUp"),
      Effect.forkIn(run.scope),
      Effect.asVoid,
    );
  });
}

/**
 * Reconcile every certified chain and threshold-anchor a restarted Router.
 * It verifies durable history, fences each conversation, asks its members
 * for catch-up, and returns: the Router worker resumes normal ingress while
 * each conversation recovers on its own, so one that cannot recover holds no
 * other. A run that starts replaces the engine's previous one.
 *
 * Re-anchoring is reserved for a conversation whose durable anchor names a
 * Router instance other than the recovery anchor. A daemon cold start reports
 * `router_restarted` because it has no prior instance in memory; conversations
 * still anchored to the polled instance recover by catch-up alone.
 * @param runtime Engine whose durable histories require reconciliation.
 * @param recoveryInput Authenticated Router recovery reason and new anchor.
 * @returns Completion once the run holds and has asked for every conversation.
 */
export const recoverCertifiedHistory = (
  runtime: EngineRuntime,
  recoveryInput: RouterWorkerRecovery,
): Effect.Effect<void, RouterWorkerRecoveryError> =>
  Effect.gen(function* () {
    const barrier = currentRecoveryBarrier(runtime);
    if (barrier === undefined) {
      return yield* Effect.fail(recoveryFailure());
    }
    yield* endRun(runtime);
    const recovered = yield* runtime.input.store
      .recover()
      .pipe(Effect.mapError(recoveryFailure));
    const memberships = yield* recoverMemberships(runtime, recovered);
    yield* verifyRecoveredHistory(runtime, recovered, memberships);
    const reanchoring = yield* reanchoringConversations(
      recoveryInput,
      recovered,
      memberships,
    );
    const retained = yield* prepareRecoveryOutbox(
      runtime,
      recovered,
      memberships,
      reanchoring,
    );
    const run = yield* makeRecoveryRun(runtime, recoveryInput, {
      memberships,
      reanchoring,
      retainedOutbounds: groupByConversation(retained),
    });
    yield* Effect.sync(() => {
      activeRuns.set(runtime, run);
    });
    yield* Effect.forEach(
      memberships.keys(),
      (conversationId) => fenceConversation(runtime, conversationId),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      memberships.keys(),
      (conversationId) => armCatchUp(run, conversationId),
      { concurrency: 1, discard: true },
    ).pipe(Effect.mapError(recoveryFailure));
    yield* endRunOnceRecovered(run);
    yield* completeRecoveryBarrier(runtime, barrier);
  }).pipe(Effect.withSpan("recoverCertifiedHistory"));

function acceptPacket(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: DirectPacket,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return routePacket(runtime, ingress, packet).pipe(
    Effect.tap(() =>
      rearmOnMemberTraffic(runtime, ingress, packetConversation(packet)),
    ),
  );
}

function routePacket(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: DirectPacket,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  switch (packet.kind) {
    case "catch_up_request":
      return acceptCatchUpRequest(catchUpResponder(runtime), ingress, packet);
    case "catch_up_page":
    case "catch_up_incomplete":
    case "completed_reanchor":
      return acceptRunPacket(runtime, ingress, packet);
    case "certified_record":
    case "action_proposal":
    case "action_certified_record":
      return acceptHistoryPacket(runtime, ingress, packet);
    default: {
      const exhaustive: never = packet;
      return exhaustive;
    }
  }
}

/**
 * Route a history or action packet by its conversation's fence. A fenced
 * conversation's certified records are applied through recovery and its
 * action traffic is ignored; an open conversation's go to the protocol
 * phases.
 * @param runtime Engine whose state receives the packet.
 * @param ingress Verified Router delivery carrying the packet.
 * @param packet The certified record or action packet.
 * @returns Whether the packet was accepted or safely ignored.
 */
function acceptHistoryPacket(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: Extract<
    DirectPacket,
    {
      readonly kind:
        | "certified_record"
        | "action_proposal"
        | "action_certified_record";
    }
  >,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  if (!isRecovering(runtime, packetConversation(packet))) {
    return runtime.phases.acceptIngress(runtime, ingress);
  }
  return packet.kind === "certified_record"
    ? acceptRecoveryRecord(runtime, ingress)
    : Effect.succeed(ignoredDisposition);
}

/**
 * Route one evidence message by the conversation its statement names. A
 * re-anchor vote goes to the recovery run. Action and durability evidence
 * for a fenced conversation is ignored, as its action traffic is; an action
 * signature for a proposal this endpoint has not seen names no conversation
 * yet and goes to the protocol phases, which ignore it.
 * @param runtime Engine whose state receives the evidence.
 * @param ingress Verified Router delivery carrying the evidence.
 * @param message The evidence message from the outer envelope.
 * @returns Whether the evidence was accepted or safely ignored.
 */
function acceptEvidence(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessage,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return decodeCanonical(EvidenceStatement, message.body).pipe(
    Effect.flatMap((statement) => {
      const conversationId = evidenceConversation(runtime, statement);
      return routeEvidence(runtime, ingress, {
        message,
        reanchorVote: statement.kind === "reanchor_vote",
        fenced:
          conversationId !== undefined && isRecovering(runtime, conversationId),
      }).pipe(
        Effect.tap(() =>
          conversationId === undefined
            ? Effect.void
            : rearmOnMemberTraffic(runtime, ingress, conversationId),
        ),
      );
    }),
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
  );
}

function routeEvidence(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  evidence: Readonly<{
    message: SignedMessage;
    reanchorVote: boolean;
    fenced: boolean;
  }>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  if (evidence.reanchorVote) {
    return acceptRunVote(runtime, ingress, evidence.message);
  }
  return evidence.fenced
    ? Effect.succeed(ignoredDisposition)
    : runtime.phases.acceptIngress(runtime, ingress);
}

function acceptRunVote(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessage,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const run = activeRuns.get(runtime);
  return run === undefined
    ? Effect.succeed(ignoredDisposition)
    : acceptReanchorVote(run.reanchor, ingress, message);
}

function acceptRunPacket(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: Extract<
    DirectPacket,
    {
      readonly kind:
        | "catch_up_page"
        | "catch_up_incomplete"
        | "completed_reanchor";
    }
  >,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const run = activeRuns.get(runtime);
  if (run === undefined) {
    return Effect.succeed(ignoredDisposition);
  }
  switch (packet.kind) {
    case "catch_up_page":
      return acceptCatchUpPage(run.catchUp, ingress, packet);
    case "catch_up_incomplete":
      return acceptCatchUpIncomplete(run.catchUp, ingress, packet);
    case "completed_reanchor":
      return acceptCompletedReanchor(run.reanchor, ingress, packet);
    default: {
      const exhaustive: never = packet;
      return exhaustive;
    }
  }
}

/**
 * Apply a certified record for a fenced conversation, then ask the active
 * run's members for the history after it. While a discontinuity has no run
 * yet, the record is applied, and the run that starts later catches up from
 * the durable position.
 * @param runtime Engine whose store takes the record.
 * @param ingress Verified Router delivery carrying the record.
 * @returns Whether the record was applied or ignored.
 */
function acceptRecoveryRecord(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return runtime.phases.acceptRecoveryIngress(runtime, ingress).pipe(
    Effect.tap((disposition) => {
      if (
        disposition !== "accepted" ||
        ingress.payload.kind !== "direct" ||
        ingress.payload.packet.kind !== "certified_record"
      ) {
        return Effect.void;
      }
      const run = activeRuns.get(runtime);
      return run === undefined
        ? Effect.void
        : requestCertifiedHistory(
            run.catchUp,
            ingress.payload.packet.actionCertifiedRecord.recordCore.action
              .conversationId,
          );
    }),
  );
}

/**
 * Arm a conversation's catch-up again after its retries ran out, on traffic
 * one of its other fixed members sent for it.
 * @param runtime Engine whose run holds the conversation.
 * @param ingress Verified Router delivery the member sent.
 * @param conversationId Conversation the delivery names.
 * @returns Completion once the conversation's catch-up is armed again.
 */
function rearmOnMemberTraffic(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const membership = activeRuns.get(runtime)?.memberships.get(conversationId);
  return membership !== undefined &&
    sentByOtherMember(runtime, membership, ingress.message.senderAgentId)
    ? rearmIfPaused(runtime, conversationId)
    : Effect.void;
}

/**
 * Arm catch-up again for a conversation the active run still holds whose
 * retries ran out. A conversation the run has recovered, or one whose retries
 * are still running, needs nothing.
 * @param runtime Engine whose run holds the conversation.
 * @param conversationId Conversation to arm.
 * @returns Completion once the conversation's catch-up is armed again.
 */
function rearmIfPaused(
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const run = activeRuns.get(runtime);
  if (
    run === undefined ||
    !run.memberships.has(conversationId) ||
    run.completedConversations.has(conversationId)
  ) {
    return Effect.void;
  }
  return FiberMap.has(run.retries, conversationId).pipe(
    Effect.flatMap((retrying) =>
      retrying ? Effect.void : armCatchUp(run, conversationId),
    ),
  );
}

/**
 * Ask a conversation's members for its history now, then retry on
 * {@link catchUpRetrySchedule} until it recovers or the retries run out. A
 * retry whose store read fails ends the retries; the conversation waits for
 * traffic to arm them again.
 * @param run Recovery run that holds the conversation.
 * @param conversationId Conversation to catch up.
 * @returns Completion once the first request is queued and the retries run.
 */
function armCatchUp(
  run: RecoveryRun,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return requestCertifiedHistory(run.catchUp, conversationId).pipe(
    Effect.zipRight(
      FiberMap.run(
        run.retries,
        conversationId,
        Effect.schedule(
          resendCertifiedHistoryRequest(run.catchUp, conversationId),
          catchUpRetrySchedule,
        ).pipe(
          Effect.asVoid,
          Effect.catchAll(() =>
            Effect.logWarning(
              "Catch-up retries stopped: the endpoint store could not be read",
            ),
          ),
        ),
      ),
    ),
    Effect.asVoid,
  );
}

/**
 * Select conversations whose durable anchor names another Router instance.
 * @param recovery Router discontinuity and the polled recovery anchor.
 * @param snapshot Exact durable state captured before recovery starts.
 * @param memberships Verified membership for every retained conversation.
 * @returns Conversations that must re-anchor; empty unless the reason is a restart.
 */
function reanchoringConversations(
  recovery: RouterWorkerRecovery,
  snapshot: EndpointRecovery,
  memberships: ReadonlyMap<ConversationIdValue, VerifiedMembership>,
): Effect.Effect<ReadonlySet<string>, RouterWorkerRecoveryError> {
  if (recovery.reason !== "router_restarted") {
    return Effect.succeed(new Set<string>());
  }
  return Effect.filter(
    memberships.values(),
    (membership) =>
      durableRouterInstanceId(membership, snapshot).pipe(
        Effect.map((instance) => instance !== recovery.anchor.routerInstanceId),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map(
      (changed) =>
        new Set<string>(
          changed.map((membership) => membership.descriptor.conversationId),
        ),
    ),
    Effect.withSpan("reanchoringConversations"),
  );
}

/**
 * Verify retained outer envelopes and invalidate only rows bound to an old Router.
 * @param runtime Engine whose local identity authored the retained envelopes.
 * @param snapshot Exact durable state captured before recovery starts.
 * @param memberships Verified membership for every retained conversation.
 * @param reanchoring Conversations anchored to another Router instance.
 * @returns Same-instance rows that must resume with their stable outbox identity.
 */
function prepareRecoveryOutbox(
  runtime: EngineRuntime,
  snapshot: EndpointRecovery,
  memberships: ReadonlyMap<ConversationIdValue, VerifiedMembership>,
  reanchoring: ReadonlySet<string>,
): Effect.Effect<readonly StoredOutboundMessage[], RouterWorkerRecoveryError> {
  return verifyStoredOutbounds(
    runtime.input,
    snapshot.outboundMessages,
    memberships,
  ).pipe(
    Effect.mapError(recoveryFailure),
    Effect.flatMap((outbounds) =>
      discardRestartedOutbounds(
        runtime,
        outbounds.filter((outbound) =>
          reanchoring.has(outbound.conversationId),
        ),
      ).pipe(
        Effect.as(
          outbounds.filter(
            (outbound) => !reanchoring.has(outbound.conversationId),
          ),
        ),
      ),
    ),
    Effect.withSpan("prepareRecoveryOutbox"),
  );
}

/**
 * Retire verified envelopes whose conversations require a new Router anchor.
 * @param runtime Engine whose durable outbox retains the envelopes.
 * @param outbounds Envelopes bound to the replaced Router instance.
 * @returns Completion once the stale envelopes are inactive.
 */
function discardRestartedOutbounds(
  runtime: EngineRuntime,
  outbounds: readonly StoredOutboundMessage[],
): Effect.Effect<void, RouterWorkerRecoveryError> {
  return runtime.input.store
    .discardOutbound(outbounds)
    .pipe(Effect.mapError(recoveryFailure), Effect.asVoid);
}

function groupByConversation(
  outbounds: readonly StoredOutboundMessage[],
): Map<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const { conversationId, outboundId } of outbounds) {
    const held = grouped.get(conversationId) ?? [];
    held.push(outboundId);
    grouped.set(conversationId, held);
  }
  return grouped;
}

/**
 * Allocate one run's scope, retries and completion accounting, and build the
 * catch-up and re-anchor ports its phases run against.
 * @param runtime Engine the run recovers.
 * @param recovery Router discontinuity reason and anchor.
 * @param history Verified memberships that must be reconciled, the
 *     conversations among them anchored to a different Router instance, and
 *     each conversation's retained envelopes.
 * @returns The run, not yet installed.
 */
function makeRecoveryRun(
  runtime: EngineRuntime,
  recovery: RouterWorkerRecovery,
  history: Pick<
    RecoveryRun,
    "memberships" | "reanchoring" | "retainedOutbounds"
  >,
): Effect.Effect<RecoveryRun> {
  return Effect.gen(function* () {
    const scope = yield* Scope.fork(
      runtime.scope,
      ExecutionStrategy.sequential,
    );
    const retries = yield* FiberMap.make<ConversationIdValue>().pipe(
      Scope.extend(scope),
    );
    const isActive = () => activeRuns.get(runtime)?.scope === scope;
    const run: RecoveryRun = {
      runtime,
      recovery,
      ...history,
      completedConversations: new Set(),
      scope,
      retries,
      catchUp: catchUpPort(runtime, history.memberships, isActive, () => run),
      reanchor: reanchorPort(
        runtime,
        { recovery, ...history },
        isActive,
        () => run,
      ),
    };
    return run;
  }).pipe(Effect.withSpan("makeRecoveryState"));
}

/**
 * Build a run's catch-up port.
 * @param runtime Engine the run recovers.
 * @param memberships Verified memberships the run reconciles.
 * @param isActive Whether the run is still the engine's active recovery.
 * @param currentRun The run the port belongs to, once it is built.
 * @returns The port the run's catch-up requests, answers, and readiness use.
 */
function catchUpPort(
  runtime: EngineRuntime,
  memberships: RecoveryRun["memberships"],
  isActive: () => boolean,
  currentRun: () => RecoveryRun,
): CatchUpRun {
  return {
    ...catchUpResponder(runtime),
    state: makeCatchUpState(),
    isActive,
    membership: (conversationId) => memberships.get(conversationId),
    onPositionReady: (conversationId) =>
      positionReady(currentRun(), conversationId).pipe(
        Effect.withSpan("positionReady"),
      ),
  };
}

/**
 * Build a run's re-anchor port.
 * @param runtime Engine the run recovers.
 * @param context The run's discontinuity, memberships, and the
 *     conversations it re-anchors.
 * @param isActive Whether the run is still the engine's active recovery.
 * @param currentRun The run the port belongs to, once it is built.
 * @returns The run's re-anchor.
 */
function reanchorPort(
  runtime: EngineRuntime,
  context: Pick<RecoveryRun, "recovery" | "memberships" | "reanchoring">,
  isActive: () => boolean,
  currentRun: () => RecoveryRun,
): ReanchorRun {
  return startReanchorRun({
    runtime,
    reason: context.recovery.reason,
    routerInstanceId: context.recovery.anchor.routerInstanceId,
    reanchoring: context.reanchoring,
    isActive,
    membership: (conversationId) => context.memberships.get(conversationId),
    isRecovered: (conversationId) =>
      currentRun().completedConversations.has(conversationId),
    markRecovered: (conversationId) =>
      markRecovered(currentRun(), conversationId),
    queue: (membership, body) =>
      queueRecoveryEnvelope(runtime, membership, body),
    requestCatchUp: (conversationId) =>
      requestCertifiedHistory(currentRun().catchUp, conversationId),
  });
}

/**
 * The catch-up responder. It answers from the active run's memberships, or
 * from the engine's conversations when no run is active.
 * @param runtime Engine that answers.
 * @returns The responder port.
 */
function catchUpResponder(runtime: EngineRuntime): CatchUpResponder {
  return {
    runtime,
    membership: (conversationId) =>
      activeRuns.get(runtime)?.memberships.get(conversationId) ??
      runtime.conversations.get(conversationId)?.membership,
    queuePacket: (membership, packet) =>
      queueRecoveryEnvelope(runtime, membership, { kind: "direct", packet }),
  };
}

/**
 * Route a conversation whose catch-up position is ready: to re-anchor after a
 * Router restart, and straight to recovered for any other reason. A member's
 * answer can complete a position after the run has ended; nothing is left to
 * route then.
 * @param run Recovery run that asked for the position.
 * @param conversationId Conversation whose position is ready.
 * @returns Completion once re-anchor has taken the position or it is recovered.
 */
function positionReady(
  run: RecoveryRun,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const membership = run.memberships.get(conversationId);
  if (!run.catchUp.isActive() || membership === undefined) {
    return Effect.void;
  }
  return run.recovery.reason === "router_restarted"
    ? reanchorPositionReady(run.reanchor, membership)
    : markRecovered(run, conversationId);
}

/**
 * Mark one conversation recovered: stop its catch-up retries, resume its
 * retained envelopes, dissemination, folds and pending posts, and then
 * release the sends waiting on its fence. The run ends once every
 * conversation it holds has recovered. The steps run uninterruptibly: the
 * conversation counts as recovered from the first of them, so nothing would
 * release a fence an interruption left held.
 * @param run Recovery run that reconciled the conversation.
 * @param conversationId Conversation whose verified position is complete.
 * @returns Completion after the conversation's held work has resumed.
 */
function markRecovered(
  run: RecoveryRun,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.suspend(() => {
    if (
      !run.catchUp.isActive() ||
      run.completedConversations.has(conversationId)
    ) {
      return Effect.void;
    }
    run.completedConversations.add(conversationId);
    return FiberMap.remove(run.retries, conversationId).pipe(
      Effect.zipRight(resumeConversation(run, conversationId)),
      Effect.zipRight(releaseConversation(run.runtime, conversationId)),
      Effect.zipRight(endRunOnceRecovered(run)),
    );
  }).pipe(Effect.uninterruptible);
}

/**
 * Resume one recovered conversation's held work: its retained envelopes in
 * durable order, its dissemination obligations, its folds' evidence, and its
 * posts not yet certified, which a re-anchor sends again at the new anchor.
 * @param run Recovery run that recovered the conversation.
 * @param conversationId Conversation that recovered.
 * @returns Completion after its held work is queued.
 */
function resumeConversation(
  run: RecoveryRun,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const { runtime } = run;
  return Effect.suspend(() => {
    const retained = run.retainedOutbounds.get(conversationId) ?? [];
    run.retainedOutbounds.delete(conversationId);
    return runtime.outbox.resume(retained);
  }).pipe(
    Effect.zipRight(
      runtime.phases.resumeDissemination(runtime, conversationId),
    ),
    Effect.zipRight(runtime.phases.resumeFolds(runtime, conversationId)),
    Effect.zipRight(
      runtime.outbox.serialized(resumeIntents(run, conversationId)),
    ),
  );
}

/**
 * Propose a recovered conversation's posts that have not certified. A post
 * proposed under a replaced anchor forgets that proposal first, so it
 * proposes again at the new one.
 * @param run Recovery run that recovered the conversation.
 * @param conversationId Conversation whose posts resume.
 * @returns Completion after each pending post is proposed.
 */
function resumeIntents(
  run: RecoveryRun,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const { runtime } = run;
  return Effect.forEach(
    [...runtime.intents.values()].filter(
      (intent) =>
        intent.intent.conversationId === conversationId &&
        !runtime.completedPosts.has(intent.intent.postId),
    ),
    (intent) =>
      Effect.suspend(() => {
        if (run.reanchoring.has(conversationId)) {
          intent.proposedActionHash = undefined;
        }
        return runtime.phases
          .proposeIntent(runtime, intent)
          .pipe(Effect.mapError(persistenceFailure));
      }),
    { concurrency: 1, discard: true },
  );
}

/**
 * End the run once every conversation it holds has recovered.
 * @param run Recovery run to check.
 * @returns Completion after a finished run is uninstalled.
 */
function endRunOnceRecovered(run: RecoveryRun): Effect.Effect<void> {
  return Effect.suspend(() =>
    run.catchUp.isActive() &&
    run.completedConversations.size === run.memberships.size
      ? endRun(run.runtime)
      : Effect.void,
  );
}

/**
 * Uninstall the engine's recovery run and end its catch-up retries.
 * @param runtime Engine whose run ends.
 * @returns Completion once no run is installed.
 */
function endRun(runtime: EngineRuntime): Effect.Effect<void> {
  return Effect.suspend(() => {
    const run = activeRuns.get(runtime);
    if (run === undefined) {
      return Effect.void;
    }
    activeRuns.delete(runtime);
    return Scope.close(run.scope, Exit.void);
  });
}

/**
 * Sign one outer envelope and queue it in the durable outbox. The Router
 * worker sends the outbox once it is active, which is as soon as the run has
 * started, so recovery traffic and the posts of recovered conversations go
 * out in one durable order.
 * @param runtime Engine whose outbox signs and retains the envelope.
 * @param membership Verified fixed membership for the outer envelope.
 * @param body Recovery packet or relayed evidence the envelope carries.
 * @returns Completion after the envelope is retained.
 */
function queueRecoveryEnvelope(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: DecodedOuterBody,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return runtime.outbox.sign(membership, body).pipe(
    Effect.flatMap((message) =>
      runtime.outbox.enqueueSigned(
        membership.descriptor.conversationId,
        message,
      ),
    ),
    Effect.mapError(persistenceFailure),
  );
}

/**
 * Whether a conversation is still fenced: by the engine fence before a run
 * has fenced each conversation, or by its own fence until it recovers.
 * @param runtime Engine whose recovery fences are read.
 * @param conversationId Conversation to check.
 * @returns True while the conversation's traffic waits for its recovery.
 */
export function isRecovering(
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
): boolean {
  return pendingRecoveryFence(runtime, conversationId) !== undefined;
}

function packetConversation(packet: DirectPacket): ConversationIdValue {
  switch (packet.kind) {
    case "catch_up_request":
      return packet.conversationId;
    case "catch_up_page":
    case "catch_up_incomplete":
      return packet.request.conversationId;
    case "completed_reanchor":
      return packet.reanchor.conversationId;
    case "certified_record":
      return packet.actionCertifiedRecord.recordCore.action.conversationId;
    case "action_proposal":
      return packet.action.conversationId;
    case "action_certified_record":
      return packet.recordCore.action.conversationId;
    default: {
      const exhaustive: never = packet;
      return exhaustive;
    }
  }
}

function evidenceConversation(
  runtime: EngineRuntime,
  statement: EvidenceStatementValue,
): ConversationIdValue | undefined {
  switch (statement.kind) {
    case "action_signature":
      return runtime.actionFolds.get(statement.actionHash)?.conversation
        .conversationId;
    case "durability_vote":
      return statement.conversationId;
    case "reanchor_vote":
      return statement.reanchor.conversationId;
    case "catch_up_attestation":
      return statement.request.conversationId;
    default: {
      const exhaustive: never = statement;
      return exhaustive;
    }
  }
}

/**
 * Validate every stored fixed membership against current engine state.
 * @param runtime Engine whose recovered conversations are authoritative.
 * @param recovery Store snapshot to validate.
 * @returns One unique verified membership per recovered conversation.
 */
function recoverMemberships(
  runtime: EngineRuntime,
  recovery: EndpointRecovery,
): Effect.Effect<
  Map<ConversationIdValue, VerifiedMembership>,
  RouterWorkerRecoveryError
> {
  return verifyStoredMemberships(
    recovery.memberships,
    runtime.input.registrySignerPublicKey,
  ).pipe(
    Effect.mapError(recoveryFailure),
    Effect.filterOrFail(
      (memberships) =>
        memberships.size === recovery.memberships.length &&
        [...memberships.values()].every((membership) =>
          recoveredMembershipMatches(runtime, membership),
        ),
      recoveryFailure,
    ),
    Effect.withSpan("recoverMemberships"),
  );
}

function recoveredMembershipMatches(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
): boolean {
  const retained = runtime.conversations.get(
    membership.descriptor.conversationId,
  );
  return (
    memberCard(membership, runtime.input.localAgentCard.agentId) !==
      undefined && retained?.membership.hash === membership.hash
  );
}

function recoveryFailure(): RouterWorkerRecoveryError {
  return new RouterWorkerRecoveryError();
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}
