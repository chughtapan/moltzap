/**
 * Test-only synchronization for per-connection cleanup steps. Replaces
 * wall-clock sleeps in integration and conformance tests. Production
 * code never imports from this module except for one tail call in
 * `app/server.ts`'s per-connection `Effect.onExit` finalizer that
 * publishes signals; with no registered waiters the publish is a
 * no-op.
 *
 * Plan: `~/.worktrees/moltzap-arch-591` (issue #591 design doc).
 *
 * Iron-rule note: every body in this file is
 * `throw new Error("not implemented")`. Implementation is downstream
 * (`implement-senior` per the design doc's tier table).
 */
import { Data, Effect } from "effect";

/**
 * The cleanup step the test wants to await. Each tag names one
 * observable side effect inside the per-connection finalizer in
 * `app/server.ts:759-805@35c65c9`. The order is the finalizer's
 * execution order; tests that pick a later step transitively observe
 * earlier ones having run.
 */
export type CleanupStep =
  | "presence-offline"
  | "disconnection-hooks"
  | "resolver-removed"
  | "lease-abandoned"
  | "presence-removed"
  | "connection-removed";

/**
 * Failure modes the test-only waiter can return. Tagged so the test
 * caller `Effect.match`es per branch; no `Promise<void>` shorthand
 * (Principle 3).
 */
export class CleanupSignalTimeout extends Data.TaggedError(
  "CleanupSignalTimeout",
)<{
  readonly connId: string;
  readonly step: CleanupStep;
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `cleanup signal for conn=${this.connId} step=${this.step} not received within ${this.timeoutMs}ms`;
  }
}

export class CleanupSignalNeverRegistered extends Data.TaggedError(
  "CleanupSignalNeverRegistered",
)<{
  readonly connId: string;
  readonly step: CleanupStep;
}> {
  override get message(): string {
    return `cleanup signal for conn=${this.connId} step=${this.step} never registered (publisher never fired)`;
  }
}

export type CleanupSignalError =
  | CleanupSignalTimeout
  | CleanupSignalNeverRegistered;

/**
 * Process-local registry of per-connection cleanup latches. One
 * instance is constructed per server lifetime and stored on the
 * `CoreApp` test surface (alongside `connections`, `leaseRegistry`).
 *
 * Implementation hint for implement-senior (not part of this file):
 * the registry holds a `Ref<HashMap<ConnId, HashMap<CleanupStep, Latch>>>`.
 * `publish` opens-or-creates-and-opens the latch. `await*` reads the
 * latch (creating if missing so a waiter racing the publisher does not
 * miss the open) and waits on it with a timeout. A retention sweep
 * drops `ConnId` entries N seconds after `connection-removed` fires so
 * the map does not grow unbounded under long-running test processes.
 */
export interface CleanupSignalRegistry {
  /**
   * Production-side publish. Called as a tail step inside the
   * per-connection `Effect.onExit` finalizer for each cleanup step.
   * Idempotent — re-publishing the same `(connId, step)` is a no-op.
   * Never fails (`E = never`) so the production finalizer cannot be
   * destabilized by test plumbing.
   */
  publish(connId: string, step: CleanupStep): Effect.Effect<void, never, never>;

  /**
   * Test-side waiter for one specific step. Returns when the
   * production publisher has fired that step for `connId`, or fails
   * with `CleanupSignalTimeout` after `timeoutMs` wall-clock.
   *
   * Calling pattern in tests:
   * ```ts
   * yield* registry.awaitStep(connId, "resolver-removed", 2_000);
   * ```
   */
  awaitStep(
    connId: string,
    step: CleanupStep,
    timeoutMs: number,
  ): Effect.Effect<void, CleanupSignalError, never>;

  /**
   * Composite — returns when the LAST step (`connection-removed`) has
   * fired. Equivalent to `awaitStep(connId, "connection-removed",
   * timeoutMs)`, exposed as its own method so the common case reads
   * declaratively at the call site.
   */
  awaitConnectionCleanup(
    connId: string,
    timeoutMs: number,
  ): Effect.Effect<void, CleanupSignalError, never>;
}

/**
 * Construct the registry. One per server lifetime.
 *
 * Implementation is deferred to `implement-senior`. The Effect itself
 * is constructed eagerly so import-time evaluation does not crash;
 * running the Effect dies with `not implemented` until the body is
 * filled in.
 */
export const makeCleanupSignalRegistry: Effect.Effect<
  CleanupSignalRegistry,
  never,
  never
> = Effect.dieMessage("not implemented: makeCleanupSignalRegistry");
