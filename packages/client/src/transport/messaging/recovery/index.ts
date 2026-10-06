/**
 * @file Recovery run lifecycle: one authenticated catch-up and re-anchor run
 * per Router discontinuity, its ingress dispatch, its outbound queue and
 * completion accounting, and the ports its catch-up and re-anchor use. Also
 * the catch-up one conversation runs outside a recovery run when a proposal
 * names a predecessor this endpoint does not hold.
 */

import type { SignedMessage } from "@moltzap/identity";
import { Deferred, Effect, Fiber, Queue, type Scope } from "effect";
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
  type RouterWorkerRecoverySend,
  type RouterWorkerSendError,
} from "../../router/index.js";
import {
  type CatchUpIncomplete,
  type CatchUpPage,
  type ConversationId as ConversationIdValue,
  type DecodedOuterBody,
  type DirectPacket,
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
import { completeRecoveryBarrier, currentRecoveryBarrier } from "./barrier.js";
import {
  acceptCatchUpIncomplete,
  acceptCatchUpPage,
  acceptCatchUpRequest,
  type CatchUpResponder,
  type CatchUpRun,
  makeCatchUpState,
  requestCertifiedHistory,
} from "./catch-up.js";

/**
 * One authenticated recovery run. Its catch-up and re-anchor reach it only
 * through the ports built here.
 */
interface RecoveryRun {
  readonly recovery: RouterWorkerRecovery;
  /**
   * Conversations whose durable anchor names a Router instance other than the
   * recovery anchor. Only these re-anchor; the rest recover by catch-up alone.
   */
  readonly reanchoring: ReadonlySet<string>;
  readonly memberships: Map<ConversationIdValue, VerifiedMembership>;
  readonly outbound: Queue.Queue<RouterWorkerRecoverySend>;
  readonly completion: Deferred.Deferred<undefined, RouterWorkerRecoveryError>;
  readonly completedConversations: Set<ConversationIdValue>;
  readonly catchUp: CatchUpRun;
  readonly reanchor: ReanchorRun;
  pendingOutbound: number;
  /**
   * Set when the run completes. The run then starts no new catch-up or
   * re-anchor work, and because its sender stops when the run ends, an
   * envelope queued after completion takes the durable outbox, which the
   * Router worker sends once recovery ends.
   */
  completed: boolean;
}

const activeRuns = new WeakMap<EngineRuntime, RecoveryRun>();

/**
 * Catch-up started outside a recovery run, one per conversation. A run ends
 * when every other member attests it holds nothing later, when a newer gap in
 * its conversation replaces it, or when a recovery run starts, which catches
 * up every conversation itself.
 */
const gapCatchUps = new WeakMap<
  EngineRuntime,
  Map<ConversationIdValue, CatchUpRun>
>();

const ignoredDisposition: RouterIngressDisposition = "ignored";

/**
 * Accept active protocol traffic, answer authenticated catch-up requests, and
 * take the members' answers to a catch-up this endpoint started outside a
 * recovery run.
 * @param runtime Engine whose active protocol state receives the ingress.
 * @param ingress Verified Router delivery and decoded private payload.
 * @returns Whether the payload was accepted or safely ignored.
 */
export function acceptEngineIngressWithRecovery(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const body = ingress.payload;
  if (body.kind === "direct" && body.packet.kind === "catch_up_request") {
    return acceptCatchUpRequest(
      catchUpResponder(runtime),
      ingress,
      body.packet,
    );
  }
  if (
    body.kind === "direct" &&
    (body.packet.kind === "catch_up_page" ||
      body.packet.kind === "catch_up_incomplete")
  ) {
    return acceptGapCatchUpAnswer(runtime, ingress, body.packet);
  }
  return runtime.phases.acceptIngress(runtime, ingress);
}

/**
 * Ask every other member for the certified history after this endpoint's
 * durable position in one conversation, outside a recovery run. Pages are
 * applied as they arrive, and certification accepts the proposal that was
 * waiting once its predecessor is certified here. The request replaces any
 * earlier catch-up for the conversation.
 * @param runtime Engine whose conversation lacks a position a proposal named.
 * @param conversationId Retained conversation to catch up.
 * @returns Completion once the request is in the durable outbox.
 */
export function requestGapCatchUp(
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.suspend(() => {
    const membership = runtime.conversations.get(conversationId)?.membership;
    if (membership === undefined) {
      return Effect.void;
    }
    const runs = gapCatchUpsOf(runtime);
    const run: CatchUpRun = {
      ...catchUpResponder(runtime),
      state: makeCatchUpState(),
      isActive: () => runs.get(conversationId) === run,
      membership: (requested) =>
        requested === conversationId ? membership : undefined,
      onPositionReady: () =>
        Effect.sync(() => {
          if (runs.get(conversationId) === run) {
            runs.delete(conversationId);
          }
        }),
    };
    runs.set(conversationId, run);
    return requestCertifiedHistory(run, conversationId);
  }).pipe(Effect.withSpan("requestGapCatchUp"));
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
    const run = activeRuns.get(runtime);
    return run === undefined
      ? Effect.succeed(ignoredDisposition)
      : acceptReanchorVote(run.reanchor, ingress, ingress.payload.message);
  }
  return acceptRecoveryPacket(runtime, ingress, ingress.payload.packet);
}

/**
 * Take a member's answer to a catch-up this endpoint started outside a
 * recovery run. An answer for a conversation with no such catch-up is
 * ignored.
 * @param runtime Engine whose gap catch-ups may own the answer.
 * @param ingress Verified Router delivery carrying the answer.
 * @param answer Catch-up page or incomplete attestation from a member.
 * @returns Whether the answer was taken or safely ignored.
 */
function acceptGapCatchUpAnswer(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  answer: CatchUpIncomplete | CatchUpPage,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const run = gapCatchUps.get(runtime)?.get(answer.request.conversationId);
  if (run === undefined) {
    return Effect.succeed(ignoredDisposition);
  }
  return answer.kind === "catch_up_page"
    ? acceptCatchUpPage(run, ingress, answer)
    : acceptCatchUpIncomplete(run, ingress, answer);
}

function gapCatchUpsOf(
  runtime: EngineRuntime,
): Map<ConversationIdValue, CatchUpRun> {
  const retained = gapCatchUps.get(runtime);
  if (retained !== undefined) {
    return retained;
  }
  const created = new Map<ConversationIdValue, CatchUpRun>();
  gapCatchUps.set(runtime, created);
  return created;
}

/**
 * Reconcile every certified chain and threshold-anchor a restarted Router.
 *
 * Re-anchoring is reserved for a conversation whose durable anchor names a
 * Router instance other than the recovery anchor. A daemon cold start reports
 * `router_restarted` because it has no prior instance in memory; conversations
 * still anchored to the polled instance recover by catch-up alone.
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
    if (activeRuns.has(runtime)) {
      return yield* Effect.fail(recoveryFailure());
    }
    yield* Effect.sync(() => gapCatchUps.delete(runtime));
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
    const retainedOutbounds = yield* prepareRecoveryOutbox(
      runtime,
      recovered,
      memberships,
      reanchoring,
    );
    const run = yield* makeRecoveryRun(
      runtime,
      recoveryInput,
      memberships,
      reanchoring,
    );
    yield* Effect.sync(() => {
      activeRuns.set(runtime, run);
    });
    yield* Effect.scoped(runRecovery(runtime, run, retainedOutbounds)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (activeRuns.get(runtime) === run) {
            activeRuns.delete(runtime);
          }
        }),
      ),
    );
    yield* completeRecoveryBarrier(runtime, barrier);
  }).pipe(Effect.withSpan("recoverCertifiedHistory"));

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
 * Queue retained envelopes until the Router worker enables normal ingress.
 * Recovery polling ignores proposals and action votes, so transmitting these
 * envelopes through its transport could consume the evidence they need.
 * @param runtime Engine whose ordinary sender waits for the recovery fence.
 * @param outbounds Verified current envelopes retained by the endpoint store.
 * @returns Completion after retained identities are queued in durable order.
 */
function resumeRecoveryOutbox(
  runtime: EngineRuntime,
  outbounds: readonly StoredOutboundMessage[],
): Effect.Effect<void> {
  return runtime.outbox
    .resume(outbounds.map((outbound) => outbound.outboundId))
    .pipe(Effect.withSpan("resumeRecoveryOutbox"));
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

function acceptRecoveryPacket(
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

function recoveryFailure(): RouterWorkerRecoveryError {
  return new RouterWorkerRecoveryError();
}

/**
 * Apply a certified record delivered as recovery traffic, then ask the active
 * run's members for the history after it. The Router worker polls recovery
 * traffic while the run is still starting and until it has finished, so a
 * record can arrive with no run active; it is applied, and a run that starts
 * later catches up from the durable position. A record for a conversation the
 * run does not hold, such as one a member created during recovery, is
 * applied without a request.
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

function runRecovery(
  runtime: EngineRuntime,
  run: RecoveryRun,
  retainedOutbounds: readonly StoredOutboundMessage[],
): Effect.Effect<
  void,
  RouterWorkerRecoveryError | RouterWorkerSendError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const sender = yield* sendRecoveryOutbound(run).pipe(Effect.forkScoped);
    yield* recoverPositions(run).pipe(Effect.mapError(recoveryFailure));
    yield* completeRecoveryIfIdle(run);
    yield* Effect.raceFirst(Deferred.await(run.completion), Fiber.join(sender));
    yield* resumeRecoveryOutbox(runtime, retainedOutbounds);
    yield* runtime.phases
      .resumeFolds(runtime)
      .pipe(Effect.mapError(recoveryFailure));
    yield* resumePendingIntents(runtime, run);
  });
}

function sendRecoveryOutbound(
  run: RecoveryRun,
): Effect.Effect<never, RouterWorkerSendError> {
  return Queue.take(run.outbound).pipe(
    Effect.flatMap((message) => run.recovery.send(message)),
    Effect.tap(() =>
      Effect.sync(() => {
        run.pendingOutbound -= 1;
      }).pipe(Effect.zipRight(completeRecoveryIfIdle(run))),
    ),
    Effect.forever,
  );
}

function recoverPositions(
  run: RecoveryRun,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.forEach(
    run.memberships.keys(),
    (conversationId) => requestCertifiedHistory(run.catchUp, conversationId),
    { concurrency: 1, discard: true },
  );
}

function resumePendingIntents(
  runtime: EngineRuntime,
  run: RecoveryRun,
): Effect.Effect<void, RouterWorkerRecoveryError | RouterWorkerSendError> {
  return runtime.outbox.serialized(
    resetReanchoredIntents(runtime, run.reanchoring).pipe(
      Effect.zipRight(resumeUncompletedIntents(runtime)),
    ),
  );
}

/**
 * Forget proposals bound to a replaced anchor so they repropose at the new one.
 * @param runtime Engine whose pending intents are examined.
 * @param reanchoring Conversations anchored to another Router instance.
 * @returns Completion after the affected proposals are cleared.
 */
function resetReanchoredIntents(
  runtime: EngineRuntime,
  reanchoring: ReadonlySet<string>,
): Effect.Effect<void> {
  return Effect.sync(() => {
    for (const intent of runtime.intents.values()) {
      if (
        reanchoring.has(intent.intent.conversationId) &&
        !runtime.completedPosts.has(intent.intent.postId)
      ) {
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
      runtime.completedPosts.has(intent.intent.postId)
        ? Effect.void
        : runtime.phases
            .proposeIntent(runtime, intent)
            .pipe(Effect.mapError(recoveryFailure)),
    { concurrency: 1, discard: true },
  );
}

/**
 * Allocate one run's queue and accounting, and build the catch-up and
 * re-anchor ports its phases run against.
 * @param runtime Engine the run recovers.
 * @param recovery RouterWorker callbacks and discontinuity anchor.
 * @param memberships Verified memberships that must be reconciled.
 * @param reanchoring Conversations anchored to a different Router instance.
 * @returns The run, not yet installed.
 */
function makeRecoveryRun(
  runtime: EngineRuntime,
  recovery: RouterWorkerRecovery,
  memberships: Map<ConversationIdValue, VerifiedMembership>,
  reanchoring: ReadonlySet<string>,
): Effect.Effect<RecoveryRun> {
  return Effect.gen(function* () {
    const run: RecoveryRun = {
      recovery,
      reanchoring,
      memberships,
      outbound: yield* Queue.unbounded<RouterWorkerRecoverySend>(),
      completion: yield* Deferred.make<undefined, RouterWorkerRecoveryError>(),
      completedConversations: new Set(),
      catchUp: {
        ...catchUpResponder(runtime),
        state: makeCatchUpState(),
        isActive: () => activeRuns.get(runtime) === run && !run.completed,
        membership: (conversationId) => memberships.get(conversationId),
        onPositionReady: (conversationId) =>
          positionReady(runtime, run, conversationId).pipe(
            Effect.withSpan("positionReady"),
          ),
      },
      reanchor: startReanchorRun({
        runtime,
        reason: recovery.reason,
        routerInstanceId: recovery.anchor.routerInstanceId,
        reanchoring,
        isActive: () => activeRuns.get(runtime) === run && !run.completed,
        membership: (conversationId) => memberships.get(conversationId),
        isRecovered: (conversationId) =>
          run.completedConversations.has(conversationId),
        markRecovered: (conversationId) =>
          markRecovered(runtime, run, conversationId),
        queue: (membership, body) =>
          queueRecoveryEnvelope(runtime, membership, body),
        requestCatchUp: (conversationId) =>
          requestCertifiedHistory(run.catchUp, conversationId),
      }),
      pendingOutbound: 0,
      completed: false,
    };
    return run;
  }).pipe(Effect.withSpan("makeRecoveryState"));
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
 * @param runtime Engine the run recovers.
 * @param run Recovery run that asked for the position.
 * @param conversationId Conversation whose position is ready.
 * @returns Completion once re-anchor has taken the position or it is recovered.
 */
function positionReady(
  runtime: EngineRuntime,
  run: RecoveryRun,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const membership = run.memberships.get(conversationId);
  if (activeRuns.get(runtime) !== run || membership === undefined) {
    return Effect.void;
  }
  return run.recovery.reason === "router_restarted"
    ? reanchorPositionReady(run.reanchor, membership)
    : markRecovered(runtime, run, conversationId);
}

/**
 * Mark one conversation reconciled and complete the run once it is idle.
 * @param runtime Engine the run recovers.
 * @param run Recovery run that reconciled the conversation.
 * @param conversationId Conversation whose verified position is complete.
 * @returns Completion after any newly idle run is released.
 */
function markRecovered(
  runtime: EngineRuntime,
  run: RecoveryRun,
  conversationId: ConversationIdValue,
): Effect.Effect<void> {
  if (activeRuns.get(runtime) !== run) {
    return Effect.void;
  }
  return Effect.sync(() => {
    run.completedConversations.add(conversationId);
  }).pipe(Effect.zipRight(completeRecoveryIfIdle(run)));
}

function completeRecoveryIfIdle(run: RecoveryRun): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (
      run.completedConversations.size !== run.memberships.size ||
      run.pendingOutbound !== 0
    ) {
      return Effect.void;
    }
    run.completed = true;
    return Deferred.succeed(run.completion, undefined).pipe(Effect.asVoid);
  });
}

/**
 * Sign one outer envelope through the outbox, then route it: to the active
 * run's queue until the run completes, otherwise to the durable outbox.
 * @param runtime Engine whose outbox signs the envelope.
 * @param membership Verified fixed membership for the outer envelope.
 * @param body Recovery packet or relayed evidence the envelope carries.
 * @returns Completion after the envelope is routed.
 */
function queueRecoveryEnvelope(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: DecodedOuterBody,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return runtime.outbox.sign(membership, body).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((message) =>
      enqueueOuter(runtime, membership.descriptor.conversationId, message),
    ),
  );
}

function enqueueOuter(
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
  message: SignedMessage,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.suspend(() => {
    const run = activeRuns.get(runtime);
    if (run === undefined || run.completed) {
      return runtime.outbox
        .enqueueSigned(conversationId, message)
        .pipe(Effect.mapError(persistenceFailure));
    }
    run.pendingOutbound += 1;
    return Queue.offer(run.outbound, { conversationId, message }).pipe(
      Effect.asVoid,
    );
  });
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

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}
