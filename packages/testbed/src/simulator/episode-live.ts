/**
 * @file Episode controller internals (contract 4): the v0 loop behind
 * `makeEpisode`. Task injection fires at its scheduled logical time as
 * principal speech; fault windows execute against the world with both
 * boundaries evented; the done-signal predicate and the inactivity bound
 * observe the drained event stream through the event log's internal tap;
 * agent exits apply the on-agent-crash policy. Termination executes the
 * outstanding fault reverts (a revert firing after episode end is still
 * executed and recorded) before the controller returns.
 */
import { Deferred, Effect, Either, Option, Schema, Stream } from "effect";
import { CorrelationId, EpisodeId, wallTimeNow } from "./ids.js";
import type {
  AgentFacingRunSpec,
  FaultScheduleEntry,
  LogicalTime,
} from "./run-spec.js";
import { getEventTaps, type SimulatorEvent } from "./event-log.js";
import type { EpisodeTermination } from "./recording.js";
import type { EpisodeDeps } from "./episode.js";
import { makeDonePredicate, type DonePredicate } from "./drivers.js";
import type {
  DriverCrashed,
  FaultApplyFailed,
  FaultRevertFailed,
  InfraError,
  TaskInjectionFailed,
} from "./errors.js";

const INACTIVITY_POLL_MS = 50;

type EpisodeContext = {
  readonly spec: AgentFacingRunSpec;
  readonly deps: EpisodeDeps;
  readonly episodeId: EpisodeId;
  readonly startedAt: LogicalTime;
  readonly done: Deferred.Deferred<EpisodeTermination, InfraError>;
  readonly activity: { lastAt: number };
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
        outstandingReverts: [],
      };
      yield* enqueueScheduler(ctx, {
        _tag: "episode.started",
        episodeId: ctx.episodeId,
      });
      yield* Effect.forkScoped(observeEvents(ctx));
      yield* Effect.forkScoped(watchAgentExits(ctx));
      yield* Effect.forkScoped(injectSeedTask(ctx));
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
        readonly _tag: "task.injected";
        readonly episodeId: EpisodeId;
        readonly principal: AgentFacingRunSpec["episode"]["task"]["principal"];
        readonly to: AgentFacingRunSpec["episode"]["task"]["to"];
        readonly content: string;
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
  return makeDonePredicate(ref).pipe(Effect.orDie);
}

function observeOne(
  ctx: EpisodeContext,
  predicate: DonePredicate | undefined,
  event: SimulatorEvent,
): Effect.Effect<void, never, never> {
  if (ACTIVITY_SOURCES.has(event.source)) {
    ctx.activity.lastAt = ctx.deps.clock.now();
  }
  if (predicate === undefined || !predicate.observe(event)) {
    return Effect.void;
  }
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
// Task injection (principal speech)
// ---------------------------------------------------------------------------

function injectSeedTask(
  ctx: EpisodeContext,
): Effect.Effect<void, never, never> {
  const task = ctx.spec.episode.task;
  return sleepUntilLogical(ctx, task.atMs).pipe(
    Effect.zipRight(
      ctx.deps.principal.deliverTask({
        episodeId: ctx.episodeId,
        task,
        world: ctx.deps.world,
      }),
    ),
    Effect.zipRight(
      enqueueScheduler(ctx, {
        _tag: "task.injected",
        episodeId: ctx.episodeId,
        principal: task.principal,
        to: task.to,
        content: task.content,
      }),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        ctx.activity.lastAt = ctx.deps.clock.now();
      }),
    ),
    Effect.catchTag("TaskInjectionFailed", (cause) => failEpisode(ctx, cause)),
  );
}

function failEpisode(
  ctx: EpisodeContext,
  cause:
    | TaskInjectionFailed
    | FaultApplyFailed
    | FaultRevertFailed
    | DriverCrashed,
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
