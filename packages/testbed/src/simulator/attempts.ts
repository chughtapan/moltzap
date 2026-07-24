/**
 * @file Run/attempt state machine and the experiment-queue + Runner
 * seams (contract 5). A recording's identity is (spec-hash, seed);
 * re-submitting an identical spec creates a new attempt under the same
 * identity, never a duplicate identity. Sealed attempts are never
 * overwritten; `retry` always creates a new attempt.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> queued
 *   queued --> launching: worker picks up
 *   queued --> cancelled: cancel before start
 *   launching --> running: episode started
 *   launching --> sealing: infra failure observed
 *   running --> draining: termination or infra failure
 *   draining --> sealing: final drain done
 *   sealing --> sealed: marker written
 *   sealing --> unsealed: seal path failed
 *   launching --> unsealed: worker lost
 *   running --> unsealed: worker lost
 *   draining --> unsealed: worker lost
 *   sealed --> [*]
 *   unsealed --> [*]
 *   cancelled --> [*]
 * ```
 *
 * Cancel semantics: cancel on `queued` yields `cancelled` (no manifest,
 * no recording); cancel on `launching`/`running` interrupts
 * cooperatively and seals with termination `interrupted`; cancel on
 * `draining`/`sealing` is recorded as a no-op — sealing is atomic and
 * happens at most once, so cancellation racing completion resolves to
 * whichever single outcome seals. Retry is legal from every terminal
 * state (`sealed`, `unsealed`, `cancelled`) and from `worker-lost`
 * detection, and never from a live attempt.
 */
import { Schema, type Effect } from "effect";
import { AttemptId, RunId, WallTimeMs } from "./ids.js";
import { RunSpec } from "./run-spec.js";
import { RecordingIdentity } from "./recording.js";
import type {
  AttemptNotRetryable,
  ConfigTimeError,
  UnknownAttempt,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Attempt states
// ---------------------------------------------------------------------------

/**
 * Live states progress `queued -> launching -> running -> draining ->
 * sealing`; terminal states are `sealed`, `unsealed`, `cancelled`. The
 * snapshot union makes impossible combinations unrepresentable: only
 * claimed attempts carry a runId, only post-manifest attempts carry a
 * recording path, only finished attempts carry `workerLost`.
 */
export const LiveAttemptState = Schema.Literal(
  "launching",
  "running",
  "draining",
  "sealing",
).annotations({ description: "Live attempt state after a worker claimed it" });
export type LiveAttemptState = typeof LiveAttemptState.Type;

export const TerminalAttemptState = Schema.Literal(
  "sealed",
  "unsealed",
  "cancelled",
).annotations({ description: "Terminal attempt state" });
export type TerminalAttemptState = typeof TerminalAttemptState.Type;

const attemptBaseFields = {
  attemptId: AttemptId,
  identity: RecordingIdentity,
  submittedAtWallTime: WallTimeMs,
} as const;

/** Submitted, not yet claimed by a worker; no manifest, no recording. */
export class QueuedAttempt extends Schema.TaggedClass<QueuedAttempt>()(
  "queued",
  {
    ...attemptBaseFields,
    cancelRequested: Schema.Boolean.annotations({
      description: "Cancel before start yields the cancelled terminal state",
    }),
  },
) {}

/** Claimed and executing; the recording path exists once the manifest persists. */
export class LiveAttempt extends Schema.TaggedClass<LiveAttempt>()("live", {
  ...attemptBaseFields,
  state: LiveAttemptState,
  runId: RunId,
  recordingPath: Schema.optional(
    Schema.String.annotations({
      description:
        "Recording directory; absent only before the manifest persists",
    }),
  ),
  cancelRequested: Schema.Boolean.annotations({
    description: "Live states honor cancel cooperatively; sealing ignores it",
  }),
}) {}

/** Finished with a recording on disk: sealed, or unsealed (seal-path failure or lost worker). */
export class FinishedAttempt extends Schema.TaggedClass<FinishedAttempt>()(
  "finished",
  {
    ...attemptBaseFields,
    state: Schema.Literal("sealed", "unsealed"),
    runId: RunId,
    recordingPath: Schema.String,
    workerLost: Schema.Boolean.annotations({
      description: "True when the executing worker died; implies unsealed",
    }),
  },
) {}

/** Cancelled before start; no manifest, no recording, no runId. */
export class CancelledAttempt extends Schema.TaggedClass<CancelledAttempt>()(
  "cancelled",
  attemptBaseFields,
) {}

/**
 * Queue-visible snapshot of one attempt (`status` output). The union
 * filters make the stated implications hold for decoded snapshots too:
 * worker loss implies unsealed, and a live attempt past `launching` has
 * a recording path (the manifest persists before launch).
 */
const AttemptSnapshot = Schema.Union(
  QueuedAttempt,
  LiveAttempt.pipe(
    Schema.filter((attempt) =>
      attempt.state === "launching" || attempt.recordingPath !== undefined
        ? undefined
        : `a ${attempt.state} attempt carries its recording path`,
    ),
  ),
  FinishedAttempt.pipe(
    Schema.filter((attempt) =>
      attempt.state === "sealed" && attempt.workerLost
        ? "worker loss implies unsealed; a dead worker seals nothing"
        : undefined,
    ),
  ),
  CancelledAttempt,
);
export type AttemptSnapshot = typeof AttemptSnapshot.Type;

export type CancelOutcome =
  | { readonly _tag: "CancelledBeforeStart" }
  | { readonly _tag: "InterruptDelivered" }
  | { readonly _tag: "AlreadyTerminal"; readonly state: TerminalAttemptState };

// ---------------------------------------------------------------------------
// Queue seam
// ---------------------------------------------------------------------------

/**
 * Experiment queue seam backing `submit` / `workers` / `status` /
 * `cancel` / `retry`. v0 ships a local single-process implementation;
 * the seam exists so a distributed queue can land without surface
 * change. Submission materializes the spec first, so config-time
 * failures surface here and never enqueue.
 */
export interface RunQueue {
  /** Materialize and enqueue; identical specs join the same recording identity with a fresh attempt. */
  submit(spec: RunSpec): Effect.Effect<AttemptSnapshot, ConfigTimeError, never>;

  /** Current record for one attempt. */
  status(
    attemptId: AttemptId,
  ): Effect.Effect<AttemptSnapshot, UnknownAttempt, never>;

  /** All attempts under one recording identity, attempt order preserved. */
  attemptsFor(
    identity: RecordingIdentity,
  ): Effect.Effect<ReadonlyArray<AttemptSnapshot>, never, never>;

  /** Request cancellation; semantics per state are documented on the state machine above. */
  cancel(
    attemptId: AttemptId,
  ): Effect.Effect<CancelOutcome, UnknownAttempt, never>;

  /** New attempt under the same identity; legal only from a terminal or worker-lost attempt. */
  retry(
    attemptId: AttemptId,
  ): Effect.Effect<
    AttemptSnapshot,
    UnknownAttempt | AttemptNotRetryable,
    never
  >;
}

// ---------------------------------------------------------------------------
// Runner seam
// ---------------------------------------------------------------------------

/**
 * Runner seam: executes queued attempts (the `workers` verb). v0 ships
 * an in-process worker loop; the seam exists so remote workers can land
 * without surface change. A runner claims one attempt at a time and
 * drives it through the state machine; it never mutates queue state it
 * does not own.
 */
export interface Runner {
  /** Claim and execute attempts until interrupted; resolves when the queue closes. */
  work(): Effect.Effect<void, never, never>;
}
