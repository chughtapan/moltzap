/**
 * @file Episode lifecycle (contract 4): task injection, logical-time
 * advance, trigger firing, and termination — plus `run`, the
 * composition root that drives one attempt end-to-end. v0 runs exactly
 * one episode per run; done-signal and inactivity terminate the episode
 * and with it the run.
 *
 * One seed deterministically derives the entire generative schedule
 * (task arrivals, wall-offset fault timings, world transitions); the
 * byte-identity claim applies to `canonicalJson` of that derived
 * schedule, never to recordings. Predicate firings are never
 * seed-derived; each is recorded in the log.
 */
import { Effect, type Scope } from "effect";
import type {
  AgentFacingRunSpec,
  FaultScheduleEntry,
  MaterializedRunSpec,
  RunSpec,
  TaskInjectionSpec,
} from "./run-spec.js";
import { episodeRun } from "./episode-live.js";
import {
  defaultRunInternals,
  runAttempt,
  type RunOptionsInternal,
} from "./run-internal.js";
import type { EpisodeId } from "./ids.js";
import type { LogicalClock, EventLog } from "./event-log.js";
import type { Launcher, Society } from "./run-config.js";
import type { Environment } from "./environment.js";
import type { World } from "./world.js";
import type {
  AllocatedAttempt,
  EpisodeTermination,
  RecordingStore,
  RunOutcome,
  SealedRecordingRef,
} from "./recording.js";
import type {
  ConfigTimeError,
  InfraError,
  ManifestPersistFailed,
  RecordingStoreFailed,
  SealFailed,
  TaskInjectionFailed,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Generative schedule (seed-derived)
// ---------------------------------------------------------------------------

/** The fully derived generative schedule; deterministic function of the materialized spec. */
export type Schedule = {
  readonly taskArrivals: ReadonlyArray<TaskInjectionSpec>;
  readonly faultWindows: ReadonlyArray<FaultScheduleEntry>;
};

/**
 * Derive the generative schedule from the materialized spec. Pure and
 * deterministic: two calls with byte-identical canonical spec
 * serializations yield byte-identical canonical schedule serializations.
 */
export function makeSchedule(spec: MaterializedRunSpec): Schedule {
  // Only the agent-facing episode and world fields feed the schedule, so
  // a condition designation cannot influence it.
  return {
    taskArrivals: [spec.episode.task],
    faultWindows: [...spec.world.faults].sort(compareFaultWindows),
  };
}

function compareFaultWindows(
  left: FaultScheduleEntry,
  right: FaultScheduleEntry,
): number {
  if (left.applyAtMs !== right.applyAtMs)
    return left.applyAtMs - right.applyAtMs;
  if (left.revertAtMs !== right.revertAtMs) {
    return left.revertAtMs - right.revertAtMs;
  }
  if (left.fault.target !== right.fault.target) {
    return left.fault.target < right.fault.target ? -1 : 1;
  }
  if (left.fault._tag === right.fault._tag) return 0;
  return left.fault._tag < right.fault._tag ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Principal seam
// ---------------------------------------------------------------------------

/** What a principal delivers: the seed task as that principal's speech. */
export type TaskDelivery = {
  readonly episodeId: EpisodeId;
  readonly task: TaskInjectionSpec;
  readonly world: Society;
};

/**
 * Principal seam: delivers seed tasks as principal speech,
 * attributed to a principal identity in the conversation flow, never a
 * system sender. Channel-agnostic on purpose: v0 delivers out-of-band;
 * a later principals-as-endpoints mode lands without surface change.
 * Implementations are named (registered), never closures.
 */
export interface Principal {
  deliverTask(
    delivery: TaskDelivery,
  ): Effect.Effect<void, TaskInjectionFailed, never>;
}

// ---------------------------------------------------------------------------
// Episode controller
// ---------------------------------------------------------------------------

/** Everything the episode controller drives. */
export type EpisodeDeps = {
  readonly world: Society;
  readonly worldDriver: World;
  readonly log: EventLog;
  readonly principal: Principal;
  readonly clock: LogicalClock;
};

/**
 * Run the single v0 episode to termination: inject the seed task at its
 * scheduled arrival, advance logical time event-driven (async-first, no
 * fixed rounds), execute fault windows, evaluate predicate triggers and
 * the done-signal, enforce the inactivity bound and the on-agent-crash
 * policy, and honor cooperative interrupts (SIGINT, cancel). Every
 * cooperative path resolves to an `EpisodeTermination`; infrastructure
 * failures fail the effect with the tagged error `run` seals.
 */
export interface Episode {
  run(
    spec: AgentFacingRunSpec,
    deps: EpisodeDeps,
  ): Effect.Effect<EpisodeTermination, InfraError, never>;
}

/** Create the v0 episode controller. */
export function makeEpisode(): Episode {
  return { run: episodeRun };
}

// ---------------------------------------------------------------------------
// run: the composition root
// ---------------------------------------------------------------------------

/**
 * Seams `run` composes; every field has a v0 default
 * implementation. `allocated` carries queue-claimed attempt ids; when
 * absent, `run` calls `store.allocateAttempt` itself, so
 * standalone runs and queue workers share one identity protocol.
 * `secrets` seeds the per-attempt registry with consumer-held credential
 * values (the registry also self-seeds from simulator-held credentials
 * and spec-borne mount env values before the manifest persists).
 */
export type RunOptions = {
  readonly store?: RecordingStore;
  readonly runner?: Launcher;
  readonly mounts?: Environment;
  readonly allocated?: AllocatedAttempt;
  readonly secrets?: ReadonlyArray<string>;
};

/** A sealed attempt: the one observable outcome plus its recording. */
export type SealedAttempt = {
  readonly recording: SealedRecordingRef;
  readonly outcome: RunOutcome;
};

/**
 * Execute one attempt end-to-end: materialize, allocate the attempt,
 * create the secret registry (seeded with simulator-held credentials,
 * `options.secrets`, and spec-borne mount env values — before the
 * manifest persists, so the manifest's redaction claim holds), persist
 * the manifest (the run begins here; before server bring-up), launch the
 * world with the condition-stripped spec, run the episode while racing
 * every long-lived failure channel (event-log sink, OTLP receiver, each
 * `world.mounts[i]`, transcript drain), then shut down in two phases:
 * (1) final transcript sweep, fault reverts, explicit `world.teardown()`
 * with its report evented; (2) `log.seal()`, `receiver.drainTraces()` +
 * `store.writeTraces`, `store.seal`. Teardown precedes the log seal so
 * `teardown.completed` and `teardownComplete` are recordable. A
 * `AlreadySealed` from the store branches on `observed`: with
 * `marker-present` the cancel side already sealed and `run` reads
 * that single outcome and returns it; with `lock-held` the cancel-side
 * sealer runs in this same process, so `run` awaits its
 * completion and then reads the marker — a lock whose holder is gone
 * classifies as unsealed via the queue's worker-loss rules. Succeeds
 * whenever a sealed recording exists — including infrastructure-failure
 * outcomes; fails only when no recording exists (config-time, allocation,
 * or manifest-persist failure) or when the seal path itself fails and
 * necessarily leaves the recording unsealed. Requires Docker only; a
 * spec's own runtimes and consumer MCP servers may add their own
 * requirements.
 */
export function run(
  spec: RunSpec,
  options?: RunOptions,
): Effect.Effect<
  SealedAttempt,
  ConfigTimeError | RecordingStoreFailed | ManifestPersistFailed | SealFailed,
  Scope.Scope
> {
  const internalOptions: RunOptionsInternal = options ?? {};
  return runAttempt(spec, internalOptions, defaultRunInternals).pipe(
    Effect.withSpan("run"),
  );
}
