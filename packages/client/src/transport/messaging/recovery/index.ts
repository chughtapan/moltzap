/**
 * @file Recovery run lifecycle: one authenticated catch-up and re-anchor run
 * per Router discontinuity, its ingress dispatch, its outbound queue and
 * completion accounting, and the ports its catch-up and re-anchor use.
 */

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
  type RouterWorkerSendError,
} from "../../router/index.js";
import {
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
 * An envelope a recovery sends, kept unsigned until its send. Each send signs
 * it afresh, so an answer carried to a later attempt goes out under a new
 * message id rather than as the durable outbox row the retry has already
 * discarded or set aside.
 */
interface RecoveryEnvelope {
  readonly membership: VerifiedMembership;
  readonly body: DecodedOuterBody;
}

/**
 * One recovery attempt: its queue to the recovery send, its envelopes not yet
 * sent, and its run once the run starts. A recovery installs it before it
 * reads the store, so an envelope queued at any point of the recovery waits
 * for the run's sender, not the durable outbox, which the Router worker sends
 * from only after recovery ends. That includes an answer to a member's
 * catch-up request that arrives before the run starts: a member recovering at
 * the same time may need the answer before it can vote, and this recovery may
 * need its vote to end. The answers an attempt leaves unsent when it ends
 * early, including one its sender was sending, open the next attempt's queue,
 * so the retry sends them first. Only answers are carried: the retry rebuilds
 * its own requests, votes and completions from durable state, but an answer
 * exists nowhere else once the member's request has been consumed.
 */
interface ActiveRecovery {
  readonly queue: Queue.Queue<RecoveryEnvelope>;
  pending: number;
  /** The envelope the sender has taken and not yet seen accepted. */
  inFlight?: RecoveryEnvelope;
  run?: RecoveryRun;
  /**
   * Set when the run completes. The run then starts no new catch-up or
   * re-anchor work, and because its sender stops when the run ends, an
   * envelope queued after completion takes the durable outbox, which the
   * Router worker sends once recovery ends.
   */
  completed: boolean;
}

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
  readonly attempt: ActiveRecovery;
  readonly completion: Deferred.Deferred<undefined, RouterWorkerRecoveryError>;
  readonly completedConversations: Set<ConversationIdValue>;
  readonly catchUp: CatchUpRun;
  readonly reanchor: ReanchorRun;
}

const activeRecoveries = new WeakMap<EngineRuntime, ActiveRecovery>();
const unsentEnvelopes = new WeakMap<
  EngineRuntime,
  readonly RecoveryEnvelope[]
>();

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
    ? acceptCatchUpRequest(
        catchUpResponder(runtime),
        ingress,
        ingress.payload.packet,
      )
    : runtime.phases.acceptIngress(runtime, ingress);
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
    const run = activeRun(runtime);
    return run === undefined
      ? Effect.succeed(ignoredDisposition)
      : acceptReanchorVote(run.reanchor, ingress, ingress.payload.message);
  }
  return acceptRecoveryPacket(runtime, ingress, ingress.payload.packet);
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
    if (activeRecoveries.has(runtime)) {
      return yield* Effect.fail(recoveryFailure());
    }
    yield* Effect.acquireUseRelease(
      installAttempt(runtime),
      (attempt) =>
        runRecoveryAttempt(runtime, recoveryInput, attempt).pipe(
          Effect.zipRight(completeRecoveryBarrier(runtime, barrier)),
        ),
      (attempt) => removeAttempt(runtime, attempt),
    );
  }).pipe(Effect.withSpan("recoverCertifiedHistory"));

/**
 * Install a recovery attempt whose queue opens with the answers the previous
 * attempt left unsent. The carried answers move into the queue and the
 * attempt is installed in one synchronous step, so an answer carried
 * meanwhile cannot be left behind.
 * @param runtime Engine starting a recovery attempt.
 * @returns The installed attempt.
 */
function installAttempt(runtime: EngineRuntime): Effect.Effect<ActiveRecovery> {
  return Queue.unbounded<RecoveryEnvelope>().pipe(
    Effect.flatMap((queue) =>
      Effect.sync(() => {
        const carried = unsentEnvelopes.get(runtime) ?? [];
        for (const envelope of carried) {
          Queue.unsafeOffer(queue, envelope);
        }
        const attempt: ActiveRecovery = {
          queue,
          pending: carried.length,
          completed: false,
        };
        unsentEnvelopes.delete(runtime);
        activeRecoveries.set(runtime, attempt);
        return attempt;
      }),
    ),
  );
}

/**
 * Remove an ended recovery attempt and keep the answers it left unsent for
 * the next one. The attempt is removed before its queue is drained, so an
 * answer queued meanwhile is carried rather than offered to a queue no sender
 * reads.
 * @param runtime Engine whose attempt ended.
 * @param attempt The attempt that ended, completed or not.
 * @returns Completion once the attempt is removed.
 */
function removeAttempt(
  runtime: EngineRuntime,
  attempt: ActiveRecovery,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (activeRecoveries.get(runtime) === attempt) {
      activeRecoveries.delete(runtime);
    }
  }).pipe(
    Effect.zipRight(Queue.takeAll(attempt.queue)),
    Effect.flatMap((queued) =>
      Effect.sync(() => {
        carryEnvelopes(runtime, [
          ...(attempt.inFlight === undefined ? [] : [attempt.inFlight]),
          ...queued,
        ]);
      }),
    ),
  );
}

function carryEnvelopes(
  runtime: EngineRuntime,
  envelopes: readonly RecoveryEnvelope[],
): void {
  const answers = envelopes.filter(isCatchUpAnswer);
  if (answers.length > 0) {
    unsentEnvelopes.set(runtime, [
      ...(unsentEnvelopes.get(runtime) ?? []),
      ...answers,
    ]);
  }
}

function isCatchUpAnswer({ body }: RecoveryEnvelope): boolean {
  return (
    body.kind === "direct" &&
    (body.packet.kind === "catch_up_page" ||
      body.packet.kind === "catch_up_incomplete")
  );
}

/**
 * Verify the durable history a recovery reconciles, then install its run in
 * the attempt and run it to completion.
 * @param runtime Engine whose durable histories require reconciliation.
 * @param recoveryInput Authenticated Router recovery callbacks and new anchor.
 * @param attempt The installed recovery attempt: the queue the run sends
 *     from, its unsent count and completion flag, and the slot its run takes.
 * @returns Completion after the run and its resumed work have finished.
 */
function runRecoveryAttempt(
  runtime: EngineRuntime,
  recoveryInput: RouterWorkerRecovery,
  attempt: ActiveRecovery,
): Effect.Effect<void, RouterWorkerRecoveryError | RouterWorkerSendError> {
  return Effect.gen(function* () {
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
    const run = yield* makeRecoveryRun(runtime, recoveryInput, attempt, {
      memberships,
      reanchoring,
    });
    yield* Effect.sync(() => {
      attempt.run = run;
    });
    yield* Effect.scoped(runRecovery(runtime, run, retainedOutbounds));
  });
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
  const run = activeRun(runtime);
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
      const run = activeRun(runtime);
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
    const sender = yield* sendRecoveryOutbound(runtime, run).pipe(
      Effect.forkScoped,
    );
    yield* recoverPositions(run).pipe(Effect.mapError(recoveryFailure));
    yield* completeRecoveryIfIdle(run);
    yield* Effect.raceFirst(Deferred.await(run.completion), Fiber.join(sender));
    yield* resumeRecoveryOutbox(runtime, retainedOutbounds);
    yield* runtime.phases
      .resumeDissemination(runtime)
      .pipe(Effect.mapError(recoveryFailure));
    yield* runtime.phases
      .resumeFolds(runtime)
      .pipe(Effect.mapError(recoveryFailure));
    yield* resumePendingIntents(runtime, run);
  });
}

/**
 * Sign and send the run's queued envelopes in order. An envelope counts as
 * in flight from the moment it leaves the queue until the Router worker
 * accepts it, so an attempt that ends mid-send carries it.
 * @param runtime Engine whose outbox signs each envelope.
 * @param run Recovery run whose attempt queue the sender drains.
 * @returns A sender that runs until the run's scope closes or a send fails.
 */
function sendRecoveryOutbound(
  runtime: EngineRuntime,
  run: RecoveryRun,
): Effect.Effect<never, RouterWorkerSendError | RouterWorkerRecoveryError> {
  const { attempt } = run;
  return Effect.uninterruptibleMask((restore) =>
    restore(Queue.take(attempt.queue)).pipe(
      Effect.tap((envelope) =>
        Effect.sync(() => {
          attempt.inFlight = envelope;
        }),
      ),
    ),
  ).pipe(
    Effect.flatMap(({ membership, body }) =>
      runtime.outbox.sign(membership, body).pipe(
        Effect.mapError(recoveryFailure),
        Effect.flatMap((message) =>
          run.recovery.send({
            conversationId: membership.descriptor.conversationId,
            message,
          }),
        ),
      ),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        delete attempt.inFlight;
        attempt.pending -= 1;
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
 * Allocate one run's completion accounting, and build the catch-up and
 * re-anchor ports its phases run against.
 * @param runtime Engine the run recovers.
 * @param recovery RouterWorker callbacks and discontinuity anchor.
 * @param attempt The installed recovery attempt the run belongs to.
 * @param history Verified memberships that must be reconciled, and the
 *     conversations among them anchored to a different Router instance.
 * @returns The run, not yet installed.
 */
function makeRecoveryRun(
  runtime: EngineRuntime,
  recovery: RouterWorkerRecovery,
  attempt: ActiveRecovery,
  history: Pick<RecoveryRun, "memberships" | "reanchoring">,
): Effect.Effect<RecoveryRun> {
  const { memberships, reanchoring } = history;
  return Effect.gen(function* () {
    const isActive = () =>
      activeRecoveries.get(runtime) === attempt && !attempt.completed;
    const run: RecoveryRun = {
      recovery,
      reanchoring,
      memberships,
      attempt,
      completion: yield* Deferred.make<undefined, RouterWorkerRecoveryError>(),
      completedConversations: new Set(),
      catchUp: {
        ...catchUpResponder(runtime),
        state: makeCatchUpState(),
        isActive,
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
        isActive,
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
      activeRun(runtime)?.memberships.get(conversationId) ??
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
  if (activeRun(runtime) !== run || membership === undefined) {
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
  if (activeRun(runtime) !== run) {
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
      run.attempt.pending !== 0
    ) {
      return Effect.void;
    }
    run.attempt.completed = true;
    return Deferred.succeed(run.completion, undefined).pipe(Effect.asVoid);
  });
}

/**
 * Route one outer envelope: to the active recovery's queue from before its
 * run starts until the run completes; an answer, to the next attempt while a
 * discontinuity has no attempt installed, which is before the first one and
 * between an attempt that ended early and its retry; otherwise, signed, to
 * the durable outbox. A retry discards a re-anchoring conversation's durable
 * rows, so an answer queued there during a discontinuity would never go out.
 * The attempt is read and offered to in one synchronous step, so the envelope
 * cannot land in a queue its attempt has already drained.
 * @param runtime Engine whose recovery or outbox takes the envelope.
 * @param membership Verified fixed membership for the outer envelope.
 * @param body Recovery packet or relayed evidence the envelope carries.
 * @returns Completion after the envelope is routed.
 */
function queueRecoveryEnvelope(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: DecodedOuterBody,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.suspend(() => {
    const envelope: RecoveryEnvelope = { membership, body };
    const attempt = activeRecoveries.get(runtime);
    if (attempt !== undefined && !attempt.completed) {
      attempt.pending += 1;
      Queue.unsafeOffer(attempt.queue, envelope);
      return Effect.void;
    }
    if (
      attempt === undefined &&
      currentRecoveryBarrier(runtime) !== undefined &&
      isCatchUpAnswer(envelope)
    ) {
      carryEnvelopes(runtime, [envelope]);
      return Effect.void;
    }
    return runtime.outbox.sign(membership, body).pipe(
      Effect.flatMap((message) =>
        runtime.outbox.enqueueSigned(
          membership.descriptor.conversationId,
          message,
        ),
      ),
      Effect.mapError(persistenceFailure),
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

function activeRun(runtime: EngineRuntime): RecoveryRun | undefined {
  return activeRecoveries.get(runtime)?.run;
}
