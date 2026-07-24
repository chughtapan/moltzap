/**
 * @file In-process RunQueue + Runner (contract 5 seams, v0). Submission
 * materializes first, so config-time failures surface at `submit` and
 * never enqueue; the store's atomic allocator claims the attempt id at
 * submission, so queued runs and standalone runs follow one identity
 * protocol. A worker fiber that dies without reporting a terminal state
 * is worker loss: the attempt finishes `unsealed` with `workerLost` and
 * stays retryable.
 */
import { Effect, Exit, Fiber, Queue, Schema } from "effect";
import { AttemptId, WallTimeMs } from "./ids.js";
import { RunSpec, materializeRunSpec } from "./run-spec.js";
import {
  RecordingIdentity,
  recordingPath,
  type AllocatedAttempt,
  type RecordingStore,
} from "./recording.js";
import {
  CancelledAttempt,
  FinishedAttempt,
  LiveAttempt,
  QueuedAttempt,
  type AttemptSnapshot,
  type CancelOutcome,
  type LiveAttemptState,
  type RunQueue,
  type Runner,
  type TerminalAttemptState,
} from "./attempts.js";
import { AttemptNotRetryable, UnknownAttempt } from "./errors.js";
import {
  defaultRunInternals,
  runAttempt,
  type RunInternals,
  type RunOptionsInternal,
} from "./run-internal.js";

export type InProcessQueueDeps = {
  readonly store: RecordingStore;
  /** Store root for computing recording paths of queued attempts; must match the store. */
  readonly storeRoot: string;
  readonly runOptions?: Omit<RunOptionsInternal, "allocated" | "store">;
  readonly internals?: RunInternals;
};

export type InProcessQueue = {
  readonly queue: RunQueue;
  readonly runner: Runner;
  /** Stops `Runner.work` loops after in-flight attempts settle. */
  readonly close: Effect.Effect<void, never, never>;
};

type AttemptRecord = {
  readonly spec: RunSpec;
  readonly allocated: AllocatedAttempt;
  snapshot: AttemptSnapshot;
  fiber: Fiber.RuntimeFiber<void, never> | undefined;
};

type QueueState = {
  readonly records: Map<AttemptId, AttemptRecord>;
  readonly pending: Queue.Queue<AttemptId>;
  readonly deps: InProcessQueueDeps;
};

/** Create the v0 single-process queue + runner pair over one store. */
export function makeInProcessQueue(
  deps: InProcessQueueDeps,
): Effect.Effect<InProcessQueue, never, never> {
  return Effect.gen(function* () {
    const state: QueueState = {
      records: new Map(),
      pending: yield* Queue.unbounded<AttemptId>(),
      deps,
    };
    const queue: RunQueue = {
      submit: (spec) => submit(state, spec),
      status: (attemptId) => status(state, attemptId),
      attemptsFor: (identity) => attemptsFor(state, identity),
      cancel: (attemptId) => cancel(state, attemptId),
      retry: (attemptId) => retry(state, attemptId),
    };
    return {
      queue,
      runner: { work: () => work(state) },
      close: Queue.shutdown(state.pending),
    };
  }).pipe(Effect.withSpan("makeInProcessQueue"));
}

function wallNow(): WallTimeMs {
  return Schema.decodeSync(WallTimeMs)(Date.now());
}

function submit(
  state: QueueState,
  spec: RunSpec,
): ReturnType<RunQueue["submit"]> {
  return Effect.gen(function* () {
    const report = yield* materializeRunSpec(Schema.encodeSync(RunSpec)(spec));
    const identity = new RecordingIdentity({
      specHash: report.specHash,
      seed: report.spec.seed,
    });
    // A store that cannot allocate is a broken environment, not an
    // expressible submission failure; the channel stays config-time only.
    const allocated = yield* state.deps.store
      .allocateAttempt(identity)
      .pipe(Effect.orDie);
    const snapshot = new QueuedAttempt({
      attemptId: allocated.attemptId,
      identity,
      submittedAtWallTime: wallNow(),
      cancelRequested: false,
    });
    state.records.set(allocated.attemptId, {
      spec,
      allocated,
      snapshot,
      fiber: undefined,
    });
    yield* Queue.offer(state.pending, allocated.attemptId);
    return snapshot;
  }).pipe(Effect.withSpan("RunQueue.submit"));
}

function recordOf(
  state: QueueState,
  attemptId: AttemptId,
): Effect.Effect<AttemptRecord, UnknownAttempt, never> {
  const record = state.records.get(attemptId);
  return record === undefined
    ? Effect.fail(
        new UnknownAttempt({
          attemptId,
          message: `No attempt "${attemptId}" exists in this queue; check the id against \`status\` output.`,
        }),
      )
    : Effect.succeed(record);
}

function status(
  state: QueueState,
  attemptId: AttemptId,
): ReturnType<RunQueue["status"]> {
  return recordOf(state, attemptId).pipe(
    Effect.map((record) => record.snapshot),
  );
}

function attemptsFor(
  state: QueueState,
  identity: RecordingIdentity,
): ReturnType<RunQueue["attemptsFor"]> {
  return Effect.sync(() =>
    [...state.records.values()]
      .filter(
        (record) =>
          record.allocated.identity.specHash === identity.specHash &&
          record.allocated.identity.seed === identity.seed,
      )
      .map((record) => record.snapshot),
  );
}

// ---------------------------------------------------------------------------
// Cancel / retry
// ---------------------------------------------------------------------------

function cancel(
  state: QueueState,
  attemptId: AttemptId,
): ReturnType<RunQueue["cancel"]> {
  return recordOf(state, attemptId).pipe(
    Effect.flatMap((record) => cancelRecord(record)),
    Effect.withSpan("RunQueue.cancel"),
  );
}

function cancelRecord(
  record: AttemptRecord,
): Effect.Effect<CancelOutcome, never, never> {
  const snapshot = record.snapshot;
  switch (snapshot._tag) {
    case "queued":
      return Effect.sync(() => {
        record.snapshot = new CancelledAttempt({
          attemptId: snapshot.attemptId,
          identity: snapshot.identity,
          submittedAtWallTime: snapshot.submittedAtWallTime,
        });
        return { _tag: "CancelledBeforeStart" } as const;
      });
    case "live":
      return cancelLive(record, snapshot);
    case "finished":
      return Effect.succeed({
        _tag: "AlreadyTerminal",
        state: snapshot.state,
      } as const);
    case "cancelled":
      return Effect.succeed({
        _tag: "AlreadyTerminal",
        state: "cancelled",
      } as const);
    default: {
      const exhaustive: never = snapshot;
      return Effect.dieMessage(
        `unreachable snapshot ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Launching/running attempts get a cooperative interrupt (the run's
 * interrupt bracket seals with termination `interrupted`); draining and
 * sealing attempts ignore cancel — sealing is at most once — so the call
 * awaits the settled terminal state and reports the recorded no-op.
 */
function cancelLive(
  record: AttemptRecord,
  snapshot: LiveAttempt,
): Effect.Effect<CancelOutcome, never, never> {
  if (snapshot.state === "draining" || snapshot.state === "sealing") {
    return awaitTerminal(record).pipe(
      Effect.map((state) => ({ _tag: "AlreadyTerminal", state }) as const),
    );
  }
  record.snapshot = new LiveAttempt({ ...snapshot, cancelRequested: true });
  return Effect.gen(function* () {
    if (record.fiber !== undefined) {
      yield* Fiber.interrupt(record.fiber);
    }
    return { _tag: "InterruptDelivered" } as const;
  });
}

const TERMINAL_POLL_MS = 25;

function awaitTerminal(
  record: AttemptRecord,
): Effect.Effect<TerminalAttemptState, never, never> {
  const snapshot = record.snapshot;
  if (snapshot._tag === "finished") return Effect.succeed(snapshot.state);
  if (snapshot._tag === "cancelled") return Effect.succeed("cancelled");
  return Effect.sleep(`${TERMINAL_POLL_MS} millis`).pipe(
    Effect.zipRight(Effect.suspend(() => awaitTerminal(record))),
  );
}

function retry(
  state: QueueState,
  attemptId: AttemptId,
): ReturnType<RunQueue["retry"]> {
  return recordOf(state, attemptId).pipe(
    Effect.flatMap((record) => {
      const snapshot = record.snapshot;
      const retryable =
        snapshot._tag === "cancelled" || snapshot._tag === "finished";
      if (!retryable) {
        return Effect.fail(
          new AttemptNotRetryable({
            attemptId,
            state: snapshot._tag === "live" ? snapshot.state : snapshot._tag,
            message: `Attempt "${attemptId}" is not terminal; retry is legal only from sealed, unsealed, cancelled, or worker-lost attempts.`,
          }),
        );
      }
      // The spec materialized cleanly at its original submission, so a
      // config-time failure on re-submission is a registry defect.
      return submit(state, record.spec).pipe(Effect.orDie);
    }),
    Effect.withSpan("RunQueue.retry"),
  );
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

function work(state: QueueState): Effect.Effect<void, never, never> {
  return Queue.take(state.pending).pipe(
    Effect.flatMap((attemptId) =>
      recordOf(state, attemptId).pipe(
        Effect.flatMap((record) => claimAndRun(state, record)),
        Effect.catchTag("UnknownAttempt", () => Effect.void),
      ),
    ),
    Effect.forever,
    Effect.catchAllCause(() => Effect.void),
    Effect.withSpan("Runner.work"),
  );
}

function claimAndRun(
  state: QueueState,
  record: AttemptRecord,
): Effect.Effect<void, never, never> {
  const snapshot = record.snapshot;
  if (snapshot._tag !== "queued" || snapshot.cancelRequested) {
    return snapshot._tag === "queued"
      ? Effect.sync(() => {
          record.snapshot = new CancelledAttempt({
            attemptId: snapshot.attemptId,
            identity: snapshot.identity,
            submittedAtWallTime: snapshot.submittedAtWallTime,
          });
        })
      : Effect.void;
  }
  return Effect.gen(function* () {
    setLiveState(state, record, "launching");
    const fiber = yield* Effect.forkDaemon(executeAttempt(state, record));
    record.fiber = fiber;
    const exit = yield* Fiber.await(fiber).pipe(
      // The worker dying here IS worker loss: the attempt is marked
      // finished-unsealed before the abandoned fiber is cut down.
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          markWorkerLost(state, record);
        }).pipe(
          Effect.zipRight(
            Effect.forkDaemon(Fiber.interrupt(fiber)).pipe(Effect.asVoid),
          ),
        ),
      ),
    );
    finishRecord(state, record, exit);
  });
}

function markWorkerLost(state: QueueState, record: AttemptRecord): void {
  if (record.snapshot._tag === "finished") return;
  record.snapshot = new FinishedAttempt({
    attemptId: record.allocated.attemptId,
    identity: record.allocated.identity,
    submittedAtWallTime: record.snapshot.submittedAtWallTime,
    state: "unsealed",
    runId: record.allocated.runId,
    recordingPath: attemptPath(state, record),
    workerLost: true,
  });
}

function setLiveState(
  state: QueueState,
  record: AttemptRecord,
  phase: LiveAttemptState,
): void {
  const base = record.snapshot;
  const cancelRequested =
    (base._tag === "live" || base._tag === "queued") && base.cancelRequested;
  record.snapshot = new LiveAttempt({
    attemptId: record.allocated.attemptId,
    identity: record.allocated.identity,
    submittedAtWallTime: base.submittedAtWallTime,
    state: phase,
    runId: record.allocated.runId,
    recordingPath: attemptPath(state, record),
    cancelRequested,
  });
}

function attemptPath(state: QueueState, record: AttemptRecord): string {
  return recordingPath(
    state.deps.storeRoot,
    record.allocated.identity,
    record.allocated.attemptId,
  );
}

function executeAttempt(
  state: QueueState,
  record: AttemptRecord,
): Effect.Effect<void, never, never> {
  const internals: RunInternals = {
    ...(state.deps.internals ?? defaultRunInternals),
    onPhase: (phase) => Effect.sync(() => setLiveState(state, record, phase)),
  };
  return Effect.scoped(
    runAttempt(
      record.spec,
      {
        ...state.deps.runOptions,
        store: state.deps.store,
        allocated: record.allocated,
      },
      internals,
    ),
  ).pipe(
    Effect.map((sealed) => {
      record.snapshot = new FinishedAttempt({
        attemptId: record.allocated.attemptId,
        identity: record.allocated.identity,
        submittedAtWallTime: record.snapshot.submittedAtWallTime,
        state: "sealed",
        runId: record.allocated.runId,
        recordingPath: sealed.recording.path,
        workerLost: false,
      });
    }),
    Effect.catchAll(() =>
      Effect.sync(() => {
        record.snapshot = new FinishedAttempt({
          attemptId: record.allocated.attemptId,
          identity: record.allocated.identity,
          submittedAtWallTime: record.snapshot.submittedAtWallTime,
          state: "unsealed",
          runId: record.allocated.runId,
          recordingPath: attemptPath(state, record),
          workerLost: false,
        });
      }),
    ),
  );
}

/**
 * A worker fiber that ends without having written a terminal snapshot
 * died mid-attempt (defect, or an interrupt that was not a cooperative
 * cancel): the attempt is observable as finished-`unsealed` with
 * `workerLost`, and stays retryable.
 */
function finishRecord(
  state: QueueState,
  record: AttemptRecord,
  exit: Exit.Exit<void, never>,
): void {
  if (record.snapshot._tag === "finished") {
    return;
  }
  const cancelled =
    record.snapshot._tag === "live" && record.snapshot.cancelRequested;
  if (cancelled && Exit.isInterrupted(exit)) {
    // The cooperative interrupt's seal path already ran inside runAttempt;
    // the marker decides sealed vs unsealed on read. The snapshot reports
    // what the worker observed last.
    record.snapshot = new FinishedAttempt({
      attemptId: record.allocated.attemptId,
      identity: record.allocated.identity,
      submittedAtWallTime: record.snapshot.submittedAtWallTime,
      state: "sealed",
      runId: record.allocated.runId,
      recordingPath: attemptPath(state, record),
      workerLost: false,
    });
    return;
  }
  record.snapshot = new FinishedAttempt({
    attemptId: record.allocated.attemptId,
    identity: record.allocated.identity,
    submittedAtWallTime: record.snapshot.submittedAtWallTime,
    state: "unsealed",
    runId: record.allocated.runId,
    recordingPath: attemptPath(state, record),
    workerLost: true,
  });
}
