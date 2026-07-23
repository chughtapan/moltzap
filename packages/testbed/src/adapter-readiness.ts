import { Effect, Option, pipe } from "effect";

import type { ReadyOutcome } from "./runtime.js";

export interface ProcessExitReadinessSource {
  readonly pollExitCode: () => Effect.Effect<
    Option.Option<number>,
    never,
    never
  >;
  readonly stderr: () => string;
  readonly timeoutMs: number;
}

/**
 * Poll the runtime child process for exit. Used alongside
 * `server.awaitAgentReady` in an `Effect.race` so we observe BOTH
 * "agent authenticated against the server" AND "process died before
 * authenticating" as competing outcomes.
 *
 * Each adapter instance tracks its process lifecycle through an
 * internal `AdapterState` object with a `tornDown` boolean guard.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> NOT_STARTED
 *   NOT_STARTED --> SPAWNED : spawn() ok
 *   NOT_STARTED --> NOT_STARTED : spawn() err — SpawnFailed propagates
 *   SPAWNED --> READY : Ready outcome
 *   SPAWNED --> TORN_DOWN : Timeout or ProcessExited outcome → teardown before fail
 *   READY --> TORN_DOWN : teardown()
 *   TORN_DOWN --> TORN_DOWN : teardown() — no-op, idempotent
 * ```
 *
 * Polls at 250ms intervals; returns `Timeout` after `source.timeoutMs`.
 */
function processExitLoop(
  source: ProcessExitReadinessSource,
): Effect.Effect<ReadyOutcome, never, never> {
  return pipe(
    Effect.iterate(null as ReadyOutcome | null, {
      while: (state) => state === null,
      body: () =>
        Effect.sleep("250 millis").pipe(
          Effect.zipRight(processExitTick(source)),
        ),
    }),
    Effect.map(
      (state): ReadyOutcome =>
        state ?? { _tag: "Timeout" as const, timeoutMs: source.timeoutMs },
    ),
  );
}

/**
 * The full readiness contract both adapters share: race server-confirmed
 * authentication against process exit, then tear down on any non-Ready
 * outcome before returning it.
 */
export function raceReadiness(input: {
  readonly serverReady: Effect.Effect<ReadyOutcome, never, never>;
  readonly source: ProcessExitReadinessSource;
  readonly teardown: () => Effect.Effect<void, never, never>;
}): Effect.Effect<ReadyOutcome, never, never> {
  return pipe(
    Effect.race(input.serverReady, processExitLoop(input.source)),
    // Final-check: if the race resolved `Timeout`, the child may have exited
    // within the last poll tick window — one last sync probe promotes that
    // case to `ProcessExited` with the actual exit code so the diagnostic
    // stderr isn't lost behind an opaque `Timeout`.
    Effect.flatMap((outcome) =>
      promoteTimeoutIfProcessExited(outcome, input.source),
    ),
    Effect.tap((outcome) =>
      outcome._tag === "Ready" ? Effect.void : input.teardown(),
    ),
  );
}

function promoteTimeoutIfProcessExited(
  outcome: ReadyOutcome,
  source: ProcessExitReadinessSource,
): Effect.Effect<ReadyOutcome, never, never> {
  if (outcome._tag !== "Timeout") {
    return Effect.succeed(outcome);
  }
  return processExitTick(source).pipe(
    Effect.map((exitOutcome) => exitOutcome ?? outcome),
  );
}

function processExitTick(
  source: ProcessExitReadinessSource,
): Effect.Effect<ReadyOutcome | null, never, never> {
  return source.pollExitCode().pipe(
    Effect.map(
      Option.match({
        onNone: () => null,
        onSome: (exitCode) => ({
          _tag: "ProcessExited" as const,
          exitCode,
          stderr: source.stderr(),
        }),
      }),
    ),
  );
}
