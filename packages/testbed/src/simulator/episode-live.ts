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
import {
  Cause,
  Deferred,
  Effect,
  Either,
  Option,
  Schema,
  Stream,
} from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
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
  PENDING,
  type DonePredicate,
  type PredicateOutcome,
} from "./drivers.js";
import {
  makeMessageLog,
  observedFrom,
  observedFromEvent,
  type AnswerCriteria,
  type AnswerOutcome,
  type MessageLog,
} from "./wire-log.js";
import { DriverCrashed } from "./errors.js";
import type {
  FaultApplyFailed,
  FaultRevertFailed,
  InfraError,
  SpeechFailed,
} from "./errors.js";

const INACTIVITY_POLL_MS = 50;

/**
 * Who a failure of the episode's own machinery is attributed to. Neither
 * of these is a driver a spec can name: a failure here is the controller's
 * own, and blaming the configured done-signal would send a reader to a
 * config that did nothing wrong.
 */
const EPISODE_OBSERVER = "episode-observer";
const REPLY_GATE = "reply-gate";

/**
 * The reply gate's state: every message this episode has observed, plus
 * the step waiting on one. The gate is a stateful predicate over the
 * whole message history rather than a subscription that can be
 * established too late — a reply is matchable whenever it is observed,
 * before or after the receipt that names the conversation to look in.
 *
 * At most one step waits at a time: `deliverSteps` is a single sequential
 * fiber that blocks on its gate before advancing. The done-signal
 * predicates read `messages` too, through `PredicateContext`.
 */
type ReplyGate = {
  readonly messages: MessageLog;
  waiting: ReplyWaiter | undefined;
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
  /** Spec-level agent names to the identities the wire reports. */
  readonly agentIds: ReadonlyMap<string, AgentId>;
  /** The last step's receipt, once it has spoken; what `last-step-answered` waits on. */
  readonly lastSpoken: { receipt: SpeechReceipt | undefined };
  /** Each named step's receipt: the only thing tying a later `into:` to the conversation it names. */
  readonly spoken: Map<StepName, SpeechReceipt>;
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
        gate: { messages: makeMessageLog(), waiting: undefined },
        agentIds: agentIdsOf(deps.world),
        lastSpoken: { receipt: undefined },
        spoken: new Map<StepName, SpeechReceipt>(),
        outstandingReverts: [],
      };
      yield* enqueueScheduler(ctx, {
        _tag: "episode.started",
        episodeId: ctx.episodeId,
      });
      // The tap does not replay, so a step spoken before the observer's
      // subscription lands is invisible to the done-signal for the rest of
      // the episode. Delivery waits for the subscription, not for the fork.
      const observing = yield* Deferred.make<void>();
      yield* Effect.forkScoped(observeEvents(ctx, observing));
      yield* Effect.forkScoped(watchAgentExits(ctx));
      yield* Effect.forkScoped(deliverSteps(ctx, observing));
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
  "wire",
]);

/**
 * The v0 episode observes drained events through `makeEventLog`'s
 * internal tap; `EpisodeDeps.log` coming from anywhere else is a
 * composition-precondition violation, reported as a defect rather than an
 * expressible run failure.
 *
 * Nothing on this path is allowed to end quietly. Observation is what
 * decides completion, so a failure or a defect here resolves the
 * episode's termination with a typed cause; swallowing it would leave the
 * run to burn its inactivity bound with nothing in the record saying why.
 */
function observeEvents(
  ctx: EpisodeContext,
  observing: Deferred.Deferred<void, never>,
): Effect.Effect<void, never, never> {
  const taps = getEventTaps(ctx.deps.log);
  if (Option.isNone(taps)) {
    return Effect.dieMessage(
      "EpisodeDeps.log lacks the v0 observation tap; construct it with makeEventLog",
    );
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const predicate = yield* resolveDonePredicate(ctx);
      const events = yield* taps.value;
      yield* Deferred.succeed(observing, undefined);
      yield* Stream.runForEach(events, (event) =>
        observeOne(ctx, predicate, event),
      );
    }),
  ).pipe(
    Effect.catchAllCause((cause) =>
      observationDefect(ctx, Cause.pretty(cause)),
    ),
  );
}

/**
 * The observing fiber is not joined, so a defect in it would otherwise
 * kill the fiber alone and leave the episode waiting on a predicate that
 * has stopped running.
 */
function observationDefect(
  ctx: EpisodeContext,
  detail: string,
): Effect.Effect<void, never, never> {
  return failEpisode(
    ctx,
    new DriverCrashed({
      driver: EPISODE_OBSERVER,
      message: `The episode's event observation stopped before the episode did: ${detail}. Completion is decided from observed events, so the run seals failed rather than waiting out its inactivity bound.`,
    }),
  );
}

function resolveDonePredicate(
  ctx: EpisodeContext,
): Effect.Effect<DonePredicate | undefined, never, never> {
  const ref = ctx.spec.episode.termination.doneSignal;
  if (ref === undefined) return Effect.succeed(undefined);
  // Materialization already validated the ref; failure here is a defect.
  return makeDonePredicate(ref, {
    agentIds: ctx.agentIds,
    steps: ctx.spec.episode.steps,
    messages: ctx.gate.messages,
    lastSpoken: ctx.lastSpoken,
  }).pipe(Effect.orDie, Effect.map(latch));
}

/**
 * One termination, one recorded firing. The predicates are re-read on
 * every observation and on the step that arms them, so a satisfied
 * condition stays satisfied and would emit a `trigger.predicate-fired`
 * per later event; a reader counting firings would see causes that never
 * existed. Latching here rather than in each driver covers the whole
 * registry, present and future.
 */
function latch(predicate: DonePredicate): DonePredicate {
  let fired = false;
  return {
    driverName: predicate.driverName,
    observe: (event: SimulatorEvent): PredicateOutcome => {
      if (fired) return PENDING;
      const outcome = predicate.observe(event);
      if (outcome._tag === "fired") fired = true;
      return outcome;
    },
  };
}

/**
 * One event, in the order the rest of the episode depends on: record the
 * evidence, then let the done-signal read it, then release a gated step.
 * The predicate shares the gate's message log, so it must run after the
 * record and not before.
 */
function observeOne(
  ctx: EpisodeContext,
  predicate: DonePredicate | undefined,
  event: SimulatorEvent,
): Effect.Effect<void, never, never> {
  return Effect.suspend(() => {
    if (ACTIVITY_SOURCES.has(event.source)) {
      ctx.activity.lastAt = ctx.deps.clock.now();
    }
    const recorded = recordObserved(ctx, event);
    if (predicate === undefined) return releaseIfRecorded(ctx, recorded);
    return applyOutcome(ctx, predicate, predicate.observe(event), recorded);
  });
}

function releaseIfRecorded(
  ctx: EpisodeContext,
  recorded: boolean,
): Effect.Effect<void, never, never> {
  return recorded ? releaseWaiting(ctx) : Effect.void;
}

function applyOutcome(
  ctx: EpisodeContext,
  predicate: DonePredicate,
  outcome: PredicateOutcome,
  recorded: boolean,
): Effect.Effect<void, never, never> {
  switch (outcome._tag) {
    case "fired":
      return fireDoneSignal(ctx, predicate, outcome.at);
    case "defective":
      return failEpisode(
        ctx,
        new DriverCrashed({
          driver: predicate.driverName,
          message: `Done-signal driver "${predicate.driverName}" cannot judge this episode: ${outcome.detail}. The run seals failed rather than reporting an unanswered society.`,
        }),
      );
    case "stalled":
      return unorderable(ctx, predicate.driverName, outcome.detail).pipe(
        Effect.zipRight(releaseIfRecorded(ctx, recorded)),
      );
    case "pending":
      return releaseIfRecorded(ctx, recorded);
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/**
 * A tie in the only ordering the wire carries. The run keeps waiting
 * rather than guessing which of the two the server committed first, and
 * says so, because a tie means the ordering assumption is weaker than
 * measured.
 */
function unorderable(
  ctx: EpisodeContext,
  waiter: string,
  detail: string,
): Effect.Effect<void, never, never> {
  return Effect.logWarning(
    `episode ${ctx.episodeId}: ${waiter} cannot order this candidate: ${detail}`,
  );
}

function fireDoneSignal(
  ctx: EpisodeContext,
  predicate: DonePredicate,
  causationId: LogicalSequence,
): Effect.Effect<void, never, never> {
  return enqueueScheduler(ctx, {
    _tag: "trigger.predicate-fired",
    episodeId: ctx.episodeId,
    predicate: predicate.driverName,
    causationId,
  }).pipe(
    Effect.zipRight(Deferred.succeed(ctx.done, "completed")),
    Effect.asVoid,
  );
}

// ---------------------------------------------------------------------------
// Reply gate
// ---------------------------------------------------------------------------

/**
 * Retain one observed message, reporting whether it was new. Retention is
 * what removes the arming race: a step gated on a reply can be armed
 * after that reply already arrived and still match it. Received messages
 * are recorded here and nowhere else, from drained events only, so every
 * one of them carries the position a firing can cite.
 */
function recordObserved(ctx: EpisodeContext, event: SimulatorEvent): boolean {
  if (event._tag !== "wire.message") return false;
  return ctx.gate.messages.record(
    { origin: "received", at: event.logicalSequence },
    observedFromEvent(event),
  );
}

/** Release the waiting step if the message just recorded answers it. */
function releaseWaiting(
  ctx: EpisodeContext,
): Effect.Effect<void, never, never> {
  return Effect.suspend(() => {
    const waiter = ctx.gate.waiting;
    if (waiter === undefined) return Effect.void;
    const matched = ctx.gate.messages.answer(waiter.criteria);
    if (matched._tag !== "answered") return gateCannotJudge(ctx, matched);
    ctx.gate.waiting = undefined;
    return Deferred.succeed(waiter.release, matched.at).pipe(Effect.asVoid);
  });
}

/**
 * The gate reads the same evidence as the done-signal and owes the same
 * answers. Its floor is the previous step's own message, written from
 * that send's synchronous result, so a missing one is the same
 * composition defect and ends the run rather than parking a step forever
 * on a question nothing can answer.
 */
function gateCannotJudge(
  ctx: EpisodeContext,
  outcome: AnswerOutcome,
): Effect.Effect<void, never, never> {
  switch (outcome._tag) {
    case "no-floor":
      return failEpisode(
        ctx,
        new DriverCrashed({
          driver: REPLY_GATE,
          message: `The step gate awaits a reply to message ${outcome.awaited}, which is absent from the episode's message log although the send that produced it writes it synchronously. The run seals failed rather than holding a step on a question nothing can answer.`,
        }),
      );
    case "ambiguous":
      return unorderable(
        ctx,
        REPLY_GATE,
        `message ${outcome.tiedWith} shares the awaited message's commit millisecond`,
      );
    case "unanswered":
    case "answered":
      return Effect.void;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
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
  const senderId = ctx.agentIds.get(from);
  if (senderId === undefined) {
    // Materialization requires `awaitReplyFrom` to name a declared agent.
    return Effect.dieMessage(
      `awaitReplyFrom names "${from}", which no launched agent answers to`,
    );
  }
  const criteria: AnswerCriteria = {
    conversationId: previous.conversationId,
    afterMessageId: previous.message.id,
    senders: new Set([senderId]),
  };
  return Effect.gen(function* () {
    const release = yield* Deferred.make<LogicalSequence, never>();
    // Register before asking. The observing fiber releases whoever is
    // waiting when it records a message, so a message recorded between
    // the question and the registration would find no one to release and
    // this step would park forever on an answer that had already arrived.
    ctx.gate.waiting = { criteria, release };
    const answered = ctx.gate.messages.answer(criteria);
    if (answered._tag !== "answered") {
      yield* gateCannotJudge(ctx, answered);
      return yield* Deferred.await(release);
    }
    ctx.gate.waiting = undefined;
    return answered.at;
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
function deliverSteps(
  ctx: EpisodeContext,
  observing: Deferred.Deferred<void, never>,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    yield* Deferred.await(observing);
    const steps = ctx.spec.episode.steps;
    let previous: SpeechReceipt | undefined;
    for (const [index, step] of steps.entries()) {
      previous = yield* deliverOneStep(
        ctx,
        step,
        previous,
        index === steps.length - 1,
      );
    }
  }).pipe(Effect.catchTag("SpeechFailed", (cause) => failEpisode(ctx, cause)));
}

/**
 * The order here is the fix for a done-signal that could never fire.
 *
 * The floor an answer has to clear is the step's own message, and it is
 * written into the log from the send's own synchronous result, in the
 * same call frame, before anything is awaited. Nothing has to arrive for
 * it to exist. Arming precedes the `step.spoken` enqueue for the same
 * reason: an answer already recorded emits no further event, so the
 * predicate has to be re-read after the arm, and the drained
 * `step.spoken` is that re-read.
 */
function deliverOneStep(
  ctx: EpisodeContext,
  step: SpeechStep,
  previous: SpeechReceipt | undefined,
  isLast: boolean,
): Effect.Effect<SpeechReceipt, SpeechFailed, never> {
  return Effect.gen(function* () {
    yield* sleepUntilLogical(ctx, step.atMs);
    const causationId = yield* holdForReply(ctx, step, previous);
    const into = yield* channelOf(ctx, step);
    const receipt = yield* ctx.deps.principal.deliver({
      episodeId: ctx.episodeId,
      step,
      world: ctx.deps.world,
      into,
    });
    ctx.gate.messages.record({ origin: "sent" }, observedFrom(receipt.message));
    if (isLast) ctx.lastSpoken.receipt = receipt;
    if (step.name !== undefined) ctx.spoken.set(step.name, receipt);
    yield* ctx.deps.observer.track(step.by, receipt);
    yield* enqueueScheduler(ctx, {
      _tag: "step.spoken",
      episodeId: ctx.episodeId,
      principal: step.by,
      content: step.say,
      taskId: receipt.taskId,
      conversationId: receipt.conversationId,
      messageId: receipt.message.id,
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
  ctx: EpisodeContext,
  step: SpeechStep,
): Effect.Effect<ChannelRef | undefined, never, never> {
  if (step.into === undefined) return Effect.succeed(undefined);
  const receipt = ctx.spoken.get(step.into);
  if (receipt === undefined) {
    // Materialization requires `into` to name an earlier step, and steps
    // run in order, so the receipt exists by the time this one speaks.
    return Effect.dieMessage(
      `step \`into: ${step.into}\` resolved to no receipt`,
    );
  }
  return Effect.succeed({
    taskId: receipt.taskId,
    conversationId: receipt.conversationId,
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
