/**
 * @file Episode controller internals (contract 4): the v0 loop behind
 * `makeEpisode`. Speech steps are delivered in array order as principal
 * speech, each held by its reply gate; fault windows execute against the
 * world with both boundaries evented; the done-signal predicate and the
 * inactivity bound observe the drained event stream through the event
 * log's internal tap; agent exits apply the on-agent-crash policy.
 * Termination executes the outstanding fault reverts (a revert firing
 * after episode end is still executed and recorded) before the controller
 * returns.
 */
import { Deferred, Effect, Either, Option, Schema, Stream } from "effect";
import {
  CorrelationId,
  EpisodeId,
  wallTimeNow,
  type LogicalSequence,
} from "./ids.js";
import type {
  AgentFacingRunSpec,
  AgentName,
  FaultScheduleEntry,
  LogicalTime,
  SpeechStep,
  StepName,
} from "./run-spec.js";
import { getEventTaps, type SimulatorEvent } from "./event-log.js";
import type { EpisodeTermination } from "./recording.js";
import type { EpisodeDeps, ChannelRef, SpeechReceipt } from "./episode.js";
import {
  agentIdsOf,
  makeDonePredicate,
  type DonePredicate,
} from "./drivers.js";
import {
  makeDeliveredLog,
  type AnswerCriteria,
  type DeliveredLog,
} from "./span-attrs.js";
import type {
  DriverCrashed,
  FaultApplyFailed,
  FaultRevertFailed,
  InfraError,
  SpeechFailed,
} from "./errors.js";

const INACTIVITY_POLL_MS = 50;

/**
 * The reply gate's state: every delivered-message span of this episode,
 * plus the steps still waiting on one. The tap is forked before any step
 * speaks, so the gate is a stateful predicate over the episode's whole
 * span history rather than a subscription that can be established too
 * late — a reply is matchable whenever its span arrives, before or after
 * the receipt that names the conversation to look in.
 */
type ReplyGate = {
  readonly delivered: DeliveredLog;
  readonly waiting: Array<ReplyWaiter>;
};

type ReplyWaiter = {
  readonly criteria: AnswerCriteria;
  readonly release: Deferred.Deferred<LogicalSequence, never>;
};

type EpisodeContext = {
  readonly spec: AgentFacingRunSpec;
  readonly deps: EpisodeDeps;
  readonly episodeId: EpisodeId;
  readonly startedAt: LogicalTime;
  readonly done: Deferred.Deferred<EpisodeTermination, InfraError>;
  readonly activity: { lastAt: number };
  readonly gate: ReplyGate;
  readonly outstandingReverts: Array<{
    readonly entry: FaultScheduleEntry;
    readonly revert: Effect.Effect<void, FaultRevertFailed, never>;
    readonly correlationId: CorrelationId;
    readonly applied: boolean;
  }>;
};

/** Drives one episode to termination; the body behind `Episode.run`. */
export function episodeRun(
  spec: AgentFacingRunSpec,
  deps: EpisodeDeps,
): Effect.Effect<EpisodeTermination, InfraError, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const ctx: EpisodeContext = {
        spec,
        deps,
        episodeId: mintEpisodeId(),
        startedAt: deps.clock.now(),
        done: yield* Deferred.make<EpisodeTermination, InfraError>(),
        activity: { lastAt: deps.clock.now() },
        gate: { delivered: makeDeliveredLog(), waiting: [] },
        outstandingReverts: [],
      };
      yield* enqueueScheduler(ctx, {
        _tag: "episode.started",
        episodeId: ctx.episodeId,
      });
      yield* Effect.forkScoped(observeEvents(ctx));
      yield* Effect.forkScoped(watchAgentExits(ctx));
      yield* Effect.forkScoped(deliverSteps(ctx));
      yield* Effect.forkScoped(runFaultWindows(ctx));
      yield* Effect.forkScoped(enforceInactivity(ctx));
      const termination = yield* Deferred.await(ctx.done);
      yield* enqueueScheduler(ctx, {
        _tag: "episode.terminated",
        episodeId: ctx.episodeId,
        termination,
      });
      yield* executeOutstandingReverts(ctx);
      return termination;
    }),
  ).pipe(Effect.withSpan("Episode.run"));
}

function mintEpisodeId(): EpisodeId {
  return Schema.decodeSync(EpisodeId)(crypto.randomUUID());
}

/**
 * Scheduler-side enqueue. An `EventLogSealed` rejection means the run is
 * already shutting down; the scheduler treats it as episode end, never as
 * an error of its own.
 */
function enqueueScheduler(
  ctx: EpisodeContext,
  fields:
    | { readonly _tag: "episode.started"; readonly episodeId: EpisodeId }
    | {
        readonly _tag: "episode.terminated";
        readonly episodeId: EpisodeId;
        readonly termination: EpisodeTermination;
      }
    | {
        readonly _tag: "step.spoken";
        readonly episodeId: EpisodeId;
        readonly principal: SpeechStep["by"];
        readonly content: string;
        readonly taskId: string;
        readonly conversationId: string;
        readonly messageId: string;
        readonly causationId?: LogicalSequence;
      }
    | {
        readonly _tag: "trigger.predicate-fired";
        readonly episodeId: EpisodeId;
        readonly predicate: string;
        readonly causationId: SimulatorEvent["logicalSequence"];
      },
): Effect.Effect<void, never, never> {
  return ctx.deps.log
    .enqueue({ ...fields, source: "scheduler", wallTime: wallTimeNow() })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("EventLogSealed", () => Effect.void),
    );
}

function enqueueFaultEvent(
  ctx: EpisodeContext,
  fields:
    | {
        readonly _tag: "fault.applied";
        readonly correlationId: CorrelationId;
        readonly faultKind: FaultScheduleEntry["fault"]["_tag"];
        readonly target: FaultScheduleEntry["fault"]["target"];
        readonly scheduledAtMs: LogicalTime;
        readonly effect: "applied" | "target-not-ready";
      }
    | {
        readonly _tag: "fault.reverted";
        readonly correlationId: CorrelationId;
        readonly faultKind: FaultScheduleEntry["fault"]["_tag"];
        readonly target: FaultScheduleEntry["fault"]["target"];
        readonly scheduledAtMs: LogicalTime;
        readonly effect: "reverted" | "was-not-applied";
      },
): Effect.Effect<void, never, never> {
  return ctx.deps.log
    .enqueue({
      ...fields,
      source: "fault",
      wallTime: wallTimeNow(),
      episodeId: ctx.episodeId,
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("EventLogSealed", () => Effect.void),
    );
}

// ---------------------------------------------------------------------------
// Observation: done-signal, activity
// ---------------------------------------------------------------------------

const ACTIVITY_SOURCES: ReadonlySet<SimulatorEvent["source"]> = new Set([
  "span",
  "transcript",
  "proxy",
]);

/**
 * The v0 episode observes drained events through `makeEventLog`'s
 * internal tap; `EpisodeDeps.log` coming from anywhere else is a
 * composition-precondition violation, reported as a defect rather than
 * an expressible run failure.
 */
function observeEvents(ctx: EpisodeContext): Effect.Effect<void, never, never> {
  const taps = getEventTaps(ctx.deps.log);
  if (Option.isNone(taps)) {
    return Effect.dieMessage(
      "EpisodeDeps.log lacks the v0 observation tap; construct it with makeEventLog",
    );
  }
  return resolveDonePredicate(ctx).pipe(
    Effect.flatMap((predicate) =>
      Stream.runForEach(taps.value, (event) =>
        observeOne(ctx, predicate, event),
      ),
    ),
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  );
}

function resolveDonePredicate(
  ctx: EpisodeContext,
): Effect.Effect<DonePredicate | undefined, never, never> {
  const ref = ctx.spec.episode.termination.doneSignal;
  if (ref === undefined) return Effect.succeed(undefined);
  // Materialization already validated the ref; failure here is a defect.
  return makeDonePredicate(ref, {
    agentIds: agentIdsOf(ctx.deps.world),
    steps: ctx.spec.episode.steps,
  }).pipe(Effect.orDie);
}

function observeOne(
  ctx: EpisodeContext,
  predicate: DonePredicate | undefined,
  event: SimulatorEvent,
): Effect.Effect<void, never, never> {
  if (ACTIVITY_SOURCES.has(event.source)) {
    ctx.activity.lastAt = ctx.deps.clock.now();
  }
  const completing =
    predicate !== undefined && predicate.observe(event) ? predicate : undefined;
  return recordDelivered(ctx, event).pipe(
    Effect.zipRight(
      completing === undefined
        ? Effect.void
        : fireDoneSignal(ctx, completing, event),
    ),
  );
}

function fireDoneSignal(
  ctx: EpisodeContext,
  predicate: DonePredicate,
  event: SimulatorEvent,
): Effect.Effect<void, never, never> {
  return enqueueScheduler(ctx, {
    _tag: "trigger.predicate-fired",
    episodeId: ctx.episodeId,
    predicate: predicate.driverName,
    causationId: event.logicalSequence,
  }).pipe(
    Effect.zipRight(Deferred.succeed(ctx.done, "completed")),
    Effect.asVoid,
  );
}

// ---------------------------------------------------------------------------
// Reply gate
// ---------------------------------------------------------------------------

/**
 * Retain every delivered-message span and release whichever waiting steps
 * it satisfies. Retention is what removes the arming race: a step gated
 * on a reply can be armed after that reply's span already arrived and
 * still match it.
 */
function recordDelivered(
  ctx: EpisodeContext,
  event: SimulatorEvent,
): Effect.Effect<void, never, never> {
  if (event._tag !== "span.accepted") return Effect.void;
  return Effect.sync(() => {
    ctx.gate.delivered.record(event.logicalSequence, event.spanName, event.raw);
  }).pipe(Effect.zipRight(releaseWaiting(ctx)));
}

function releaseWaiting(
  ctx: EpisodeContext,
): Effect.Effect<void, never, never> {
  return Effect.suspend(() => {
    const stillWaiting: Array<ReplyWaiter> = [];
    const releases: Array<Effect.Effect<void, never, never>> = [];
    for (const waiter of ctx.gate.waiting) {
      const matched = ctx.gate.delivered.answer(waiter.criteria);
      if (matched === undefined) {
        stillWaiting.push(waiter);
        continue;
      }
      releases.push(
        Deferred.succeed(waiter.release, matched).pipe(Effect.asVoid),
      );
    }
    ctx.gate.waiting.splice(0, ctx.gate.waiting.length, ...stillWaiting);
    return Effect.all(releases, { concurrency: 1, discard: true });
  });
}

/**
 * Hold until the named agent has replied to the previous step. Sequencing
 * a probe by clock offset instead fails toward a false pass: a probe that
 * lands before the agent ingested the setup makes the run prove nothing
 * while still producing a clean verdict.
 */
function awaitReply(
  ctx: EpisodeContext,
  from: AgentName,
  previous: SpeechReceipt,
): Effect.Effect<LogicalSequence, never, never> {
  const senderId = ctx.deps.world.agents.find(
    (agent) => agent.slot === from,
  )?.agentId;
  if (senderId === undefined) {
    // Materialization requires `awaitReplyFrom` to name a declared agent.
    return Effect.dieMessage(
      `awaitReplyFrom names "${from}", which no launched agent answers to`,
    );
  }
  const criteria: AnswerCriteria = {
    conversationId: previous.conversationId,
    afterMessageId: previous.messageId,
    senders: new Set([senderId]),
  };
  return Effect.gen(function* () {
    const immediate = ctx.gate.delivered.answer(criteria);
    if (immediate !== undefined) return immediate;
    const release = yield* Deferred.make<LogicalSequence, never>();
    ctx.gate.waiting.push({ criteria, release });
    return yield* Deferred.await(release);
  });
}

// ---------------------------------------------------------------------------
// Agent exits (on-agent-crash policy)
// ---------------------------------------------------------------------------

function watchAgentExits(
  ctx: EpisodeContext,
): Effect.Effect<void, never, never> {
  return Effect.forEach(
    ctx.deps.world.agents,
    (agent) => watchOneAgent(ctx, agent),
    // One waiting fiber per launched agent; the collection bounds it.
    { concurrency: Math.max(1, ctx.deps.world.agents.length), discard: true },
  );
}

function watchOneAgent(
  ctx: EpisodeContext,
  agent: EpisodeDeps["world"]["agents"][number],
): Effect.Effect<void, never, never> {
  return agent.runtime.awaitExit().pipe(
    Effect.flatMap((exit) =>
      ctx.deps.log
        .enqueue({
          _tag: "agent.exited",
          source: "lifecycle",
          wallTime: wallTimeNow(),
          agent: agent.slot,
          exitCode: exit.exitCode,
          episodeId: ctx.episodeId,
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag("EventLogSealed", () => Effect.void),
        ),
    ),
    Effect.zipRight(
      ctx.spec.episode.termination.onAgentCrash === "halt"
        ? Deferred.succeed(ctx.done, "agent-crashed").pipe(Effect.asVoid)
        : Effect.void,
    ),
  );
}

// ---------------------------------------------------------------------------
// Speech steps (principal speech)
// ---------------------------------------------------------------------------

/**
 * Deliver the episode's steps in array order. Order is the only
 * sequencing mechanism, so one sequential fiber drives them all; each
 * step's receipt stays addressable by name, because that is the only
 * thing that ties a later `into:` to the conversation an earlier step
 * created.
 */
function deliverSteps(ctx: EpisodeContext): Effect.Effect<void, never, never> {
  const spoken = new Map<StepName, SpeechReceipt>();
  return Effect.gen(function* () {
    let previous: SpeechReceipt | undefined;
    for (const step of ctx.spec.episode.steps) {
      previous = yield* deliverOneStep(ctx, step, spoken, previous);
    }
  }).pipe(Effect.catchTag("SpeechFailed", (cause) => failEpisode(ctx, cause)));
}

function deliverOneStep(
  ctx: EpisodeContext,
  step: SpeechStep,
  spoken: Map<StepName, SpeechReceipt>,
  previous: SpeechReceipt | undefined,
): Effect.Effect<SpeechReceipt, SpeechFailed, never> {
  return Effect.gen(function* () {
    yield* sleepUntilLogical(ctx, step.atMs);
    const causationId = yield* holdForReply(ctx, step, previous);
    const channel = yield* channelOf(step, spoken);
    const receipt = yield* ctx.deps.principal.deliver({
      episodeId: ctx.episodeId,
      step,
      world: ctx.deps.world,
      ...channel,
    });
    if (step.name !== undefined) spoken.set(step.name, receipt);
    yield* enqueueScheduler(ctx, {
      _tag: "step.spoken",
      episodeId: ctx.episodeId,
      principal: step.by,
      content: step.say,
      taskId: receipt.taskId,
      conversationId: receipt.conversationId,
      messageId: receipt.messageId,
      // An absent optional stays absent: an explicit `undefined` is
      // outside the JSON value space the event line is serialized in.
      ...(causationId === undefined ? {} : { causationId }),
    });
    ctx.activity.lastAt = ctx.deps.clock.now();
    return receipt;
  });
}

/** The conversation a `send` step speaks into, resolved from the receipt of the step it names. */
function channelOf(
  step: SpeechStep,
  spoken: ReadonlyMap<StepName, SpeechReceipt>,
): Effect.Effect<{ readonly into?: ChannelRef }, never, never> {
  if (step.into === undefined) return Effect.succeed({});
  const receipt = spoken.get(step.into);
  if (receipt === undefined) {
    // Materialization requires `into` to name an earlier step, and steps
    // run in order, so the receipt exists by the time this one speaks.
    return Effect.dieMessage(
      `step \`into: ${step.into}\` resolved to no receipt`,
    );
  }
  return Effect.succeed({
    into: {
      taskId: receipt.taskId,
      conversationId: receipt.conversationId,
    },
  });
}

function holdForReply(
  ctx: EpisodeContext,
  step: SpeechStep,
  previous: SpeechReceipt | undefined,
): Effect.Effect<LogicalSequence | undefined, never, never> {
  if (step.awaitReplyFrom === undefined) return Effect.succeed(undefined);
  if (previous === undefined) {
    // Materialization rejects a gate on the first step.
    return Effect.dieMessage("a gated first step escaped materialization");
  }
  return awaitReply(ctx, step.awaitReplyFrom, previous);
}

function failEpisode(
  ctx: EpisodeContext,
  cause: SpeechFailed | FaultApplyFailed | FaultRevertFailed | DriverCrashed,
): Effect.Effect<void, never, never> {
  return Deferred.fail(ctx.done, cause).pipe(Effect.asVoid);
}

function sleepUntilLogical(
  ctx: EpisodeContext,
  atMs: number,
): Effect.Effect<void, never, never> {
  const waitMs = atMs - ctx.deps.clock.now();
  return waitMs > 0 ? Effect.sleep(`${waitMs} millis`) : Effect.void;
}

// ---------------------------------------------------------------------------
// Fault windows
// ---------------------------------------------------------------------------

function runFaultWindows(
  ctx: EpisodeContext,
): Effect.Effect<void, never, never> {
  return Effect.forEach(
    ctx.spec.world.faults,
    (entry) => runOneFaultWindow(ctx, entry),
    // One timer fiber per scheduled window; the schedule bounds it.
    { concurrency: Math.max(1, ctx.spec.world.faults.length), discard: true },
  );
}

/**
 * A window whose apply time precedes episode start was scheduled before
 * the target's readiness (launch gates readiness): the scheduled apply is
 * recorded with effect `target-not-ready` and never executed — neither a
 * crash nor a silent skip — and its revert records `was-not-applied`.
 */
function runOneFaultWindow(
  ctx: EpisodeContext,
  entry: FaultScheduleEntry,
): Effect.Effect<void, never, never> {
  if (entry.applyAtMs < ctx.startedAt) {
    return recordUnreadyWindow(ctx, entry);
  }
  return sleepUntilLogical(ctx, entry.applyAtMs).pipe(
    Effect.zipRight(ctx.deps.worldDriver.apply(entry.fault)),
    Effect.flatMap((applied) =>
      enqueueFaultEvent(ctx, {
        _tag: "fault.applied",
        correlationId: applied.correlationId,
        faultKind: entry.fault._tag,
        target: entry.fault.target,
        scheduledAtMs: entry.applyAtMs,
        effect: "applied",
      }).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            ctx.outstandingReverts.push({
              entry,
              revert: applied.revert(),
              correlationId: applied.correlationId,
              applied: true,
            });
          }),
        ),
        Effect.zipRight(sleepUntilLogical(ctx, entry.revertAtMs)),
        // Suspended: the sync claim inside revertOne must observe the
        // outstanding entry pushed above, not construction-time state.
        Effect.zipRight(
          Effect.suspend(() => revertOne(ctx, applied.correlationId, entry)),
        ),
      ),
    ),
    Effect.catchTag("FaultUnsupported", () =>
      // Materialization rejects unhonored kinds; reaching here is a defect.
      Effect.dieMessage("unhonored fault kind escaped materialization"),
    ),
    Effect.catchTag("FaultApplyFailed", (cause) => failEpisode(ctx, cause)),
    Effect.catchTag("FaultRevertFailed", (cause) => failEpisode(ctx, cause)),
  );
}

function recordUnreadyWindow(
  ctx: EpisodeContext,
  entry: FaultScheduleEntry,
): Effect.Effect<void, never, never> {
  const correlationId = Schema.decodeSync(CorrelationId)(crypto.randomUUID());
  return enqueueFaultEvent(ctx, {
    _tag: "fault.applied",
    correlationId,
    faultKind: entry.fault._tag,
    target: entry.fault.target,
    scheduledAtMs: entry.applyAtMs,
    effect: "target-not-ready",
  }).pipe(
    // The pending `was-not-applied` boundary registers as outstanding
    // before the timer sleeps, so an episode terminating first still
    // records it through the post-termination sweep.
    Effect.zipRight(
      Effect.sync(() => {
        ctx.outstandingReverts.push({
          entry,
          revert: Effect.void,
          correlationId,
          applied: false,
        });
      }),
    ),
    Effect.zipRight(sleepUntilLogical(ctx, entry.revertAtMs)),
    Effect.zipRight(Effect.suspend(() => revertOne(ctx, correlationId, entry))),
    Effect.catchTag("FaultRevertFailed", (cause) => failEpisode(ctx, cause)),
  );
}

function revertOne(
  ctx: EpisodeContext,
  correlationId: CorrelationId,
  entry: FaultScheduleEntry,
): Effect.Effect<void, FaultRevertFailed, never> {
  // The entry is claimed synchronously before the revert executes, so a
  // window fiber racing the post-termination sweep cannot revert twice.
  const index = ctx.outstandingReverts.findIndex(
    (candidate) => candidate.correlationId === correlationId,
  );
  if (index < 0) return Effect.void;
  const [pending] = ctx.outstandingReverts.splice(index, 1);
  if (pending === undefined) return Effect.void;
  return pending.revert.pipe(
    Effect.zipRight(
      enqueueFaultEvent(ctx, {
        _tag: "fault.reverted",
        correlationId,
        faultKind: entry.fault._tag,
        target: entry.fault.target,
        scheduledAtMs: entry.revertAtMs,
        effect: pending.applied ? "reverted" : "was-not-applied",
      }),
    ),
  );
}

/**
 * Fault windows can overlap episode end; the outstanding reverts execute
 * here — after termination, before the controller returns — so both
 * boundaries are always recorded and the world is healed for teardown.
 * Every revert is attempted; `ctx.done` is already resolved by now, so a
 * failure travels on the return channel to seal as `fault-revert-failed`.
 */
function executeOutstandingReverts(
  ctx: EpisodeContext,
): Effect.Effect<void, FaultRevertFailed, never> {
  return Effect.forEach(
    [...ctx.outstandingReverts],
    (pending) =>
      Effect.either(revertOne(ctx, pending.correlationId, pending.entry)),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((results) => {
      const failed = results.find(Either.isLeft);
      return failed === undefined ? Effect.void : Effect.fail(failed.left);
    }),
  );
}

// ---------------------------------------------------------------------------
// Inactivity bound
// ---------------------------------------------------------------------------

function enforceInactivity(
  ctx: EpisodeContext,
): Effect.Effect<void, never, never> {
  const bound = ctx.spec.episode.termination.inactivityTimeoutMs;
  return Effect.gen(function* () {
    for (;;) {
      const idleFor = ctx.deps.clock.now() - ctx.activity.lastAt;
      if (idleFor >= bound) {
        yield* Deferred.succeed(ctx.done, "timeout");
        return;
      }
      const waitMs = Math.max(INACTIVITY_POLL_MS, bound - idleFor);
      yield* Effect.sleep(`${waitMs} millis`);
    }
  });
}
