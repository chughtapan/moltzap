/**
 * @file Typed errors raised by the runtime adapters and testbed
 * orchestration. Every adapter's `spawn()` and `waitUntilReady()`
 * uses these types in their `E` channel.
 */
import { Data } from "effect";

/**
 * Raised by `Runtime.spawn()` in any adapter when the child process
 * cannot be started — exec error, missing binary, port allocation
 * failure, state-dir creation failure.
 *
 * `cause` carries the underlying Error.
 * Caller action: surface to user. No retry — binary or config is wrong.
 */
export class SpawnFailed extends Data.TaggedError("SpawnFailed")<{
  readonly agentName: string;
  readonly message: string;
  readonly cause: Error;
}> {}

/**
 * Raised by `startPendingRuntimeAgent` when `waitUntilReady` returns
 * `Timeout`. The process did not signal ready within `timeoutMs` and
 * has been torn down before the failure reaches the caller.
 *
 * Caller action: increase `readyTimeoutMs`, or enable process-level
 * diagnostics at the adapter boundary.
 */
export class RuntimeReadyTimedOut extends Data.TaggedError(
  "RuntimeReadyTimedOut",
)<{
  readonly agentName: string;
  readonly timeoutMs: number;
  readonly message: string;
}> {}

/**
 * Raised by `startPendingRuntimeAgent` when `waitUntilReady` returns
 * `ProcessExited`. The process exited before reaching ready.
 *
 * `stderr` carries the full accumulated stdout+stderr at exit;
 * `exitCode` is `null` only if the process exited via signal.
 * Caller action: inspect `stderr`; check binary auth config.
 */
export class RuntimeExitedBeforeReady extends Data.TaggedError(
  "RuntimeExitedBeforeReady",
)<{
  readonly agentName: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly message: string;
}> {}

/**
 * Union of every failure mode `startRuntimeAgent` and `launchTestbed` can
 * produce. Use `Effect.catchTags` to
 * branch by tag, or `Effect.catchAll` to handle uniformly.
 *
 * Note: `TestbedStartupInterrupted` lives in `testbed.ts` because it only
 * arises in the signal-handling variant and carries the interrupting `Signal`.
 */
export type RuntimeLaunchFailed =
  | SpawnFailed
  | RuntimeReadyTimedOut
  | RuntimeExitedBeforeReady;
