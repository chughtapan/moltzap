/**
 * @file Episode lifecycle (contract 4): task injection, logical-time
 * advance, trigger firing, and termination — plus `executeRun`, the
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
import type { Effect, Scope } from "effect";
import type {
  AgentFacingRunSpec,
  FaultScheduleEntry,
  MaterializedRunSpec,
  RunSpec,
  TaskInjectionSpec,
} from "./run-spec.js";
import type { EpisodeId } from "./ids.js";
import type { LogicalClock, EventLogHandle } from "./event-log.js";
import type { AgentRunner, LaunchedWorld } from "./run-config.js";
import type { EnvironmentMount } from "./environment-mount.js";
import type { WorldDriver } from "./world-driver.js";
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
export type GenerativeSchedule = {
  readonly taskArrivals: ReadonlyArray<TaskInjectionSpec>;
  readonly faultWindows: ReadonlyArray<FaultScheduleEntry>;
};

/**
 * Derive the generative schedule from the materialized spec. Pure and
 * deterministic: two calls with byte-identical canonical spec
 * serializations yield byte-identical canonical schedule serializations.
 */
export function deriveGenerativeSchedule(
  _spec: MaterializedRunSpec,
): GenerativeSchedule {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// PrincipalDriver seam
// ---------------------------------------------------------------------------

/** What a principal delivers: the seed task as that principal's speech. */
export type TaskDelivery = {
  readonly episodeId: EpisodeId;
  readonly task: TaskInjectionSpec;
  readonly world: LaunchedWorld;
};

/**
 * PrincipalDriver seam: delivers seed tasks as principal speech,
 * attributed to a principal identity in the conversation flow, never a
 * system sender. Channel-agnostic on purpose: v0 delivers out-of-band;
 * a later principals-as-endpoints mode lands without surface change.
 * Implementations are named (registered), never closures.
 */
export interface PrincipalDriver {
  deliverTask(
    delivery: TaskDelivery,
  ): Effect.Effect<void, TaskInjectionFailed, never>;
}

// ---------------------------------------------------------------------------
// Episode controller
// ---------------------------------------------------------------------------

/** Everything the episode controller drives. */
export type EpisodeDeps = {
  readonly world: LaunchedWorld;
  readonly worldDriver: WorldDriver;
  readonly log: EventLogHandle;
  readonly principal: PrincipalDriver;
  readonly clock: LogicalClock;
};

/**
 * Run the single v0 episode to termination: inject the seed task at its
 * scheduled arrival, advance logical time event-driven (async-first, no
 * fixed rounds), execute fault windows, evaluate predicate triggers and
 * the done-signal, enforce the inactivity bound and the on-agent-crash
 * policy, and honor cooperative interrupts (SIGINT, cancel). Every
 * cooperative path resolves to an `EpisodeTermination`; infrastructure
 * failures fail the effect with the tagged error `executeRun` seals.
 */
export interface EpisodeController {
  run(
    spec: AgentFacingRunSpec,
    deps: EpisodeDeps,
  ): Effect.Effect<EpisodeTermination, InfraError, never>;
}

/** Create the v0 episode controller. */
export function makeEpisodeController(): EpisodeController {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// executeRun: the composition root
// ---------------------------------------------------------------------------

/**
 * Seams `executeRun` composes; every field has a v0 default
 * implementation. `allocated` carries queue-claimed attempt ids; when
 * absent, `executeRun` calls `store.allocateAttempt` itself, so
 * standalone runs and queue workers share one identity protocol.
 * `secrets` seeds the per-attempt registry with consumer-held credential
 * values (the registry also self-seeds from simulator-held credentials
 * and spec-borne mount env values before the manifest persists).
 */
export type ExecuteRunOptions = {
  readonly store?: RecordingStore;
  readonly runner?: AgentRunner;
  readonly mounts?: EnvironmentMount;
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
 * `SealRaceLost` from the store branches on `observed`: with
 * `marker-present` the cancel side already sealed and `executeRun` reads
 * that single outcome and returns it; with `lock-held` the cancel-side
 * sealer runs in this same process, so `executeRun` awaits its
 * completion and then reads the marker — a lock whose holder is gone
 * classifies as unsealed via the queue's worker-loss rules. Succeeds
 * whenever a sealed recording exists — including infrastructure-failure
 * outcomes; fails only when no recording exists (config-time, allocation,
 * or manifest-persist failure) or when the seal path itself fails and
 * necessarily leaves the recording unsealed. Requires Docker only; a
 * spec's own runtimes and consumer MCP servers may add their own
 * requirements.
 */
export function executeRun(
  _spec: RunSpec,
  _options?: ExecuteRunOptions,
): Effect.Effect<
  SealedAttempt,
  ConfigTimeError | RecordingStoreFailed | ManifestPersistFailed | SealFailed,
  Scope.Scope
> {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}
