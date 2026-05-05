/**
 * Conformance — appCallback dispatcher concurrency invariants.
 *
 * Spec: moltzap#356 §8 (test plan, file 4).
 *
 * Cross-implementation contract: any client that drains appCallback request
 * frames MUST run hooks for distinct `(taskId, conversationId,
 * hookKind)` tuples on independent fibers. A `before_dispatch` hook
 * suspended on a `Deferred.await` MUST NOT delay a sibling
 * `before_message_delivery` hook for the same conversation.
 *
 * The reproducer that exercised this (arena#246, arena#248):
 *
 *   1. Server sends `apps/onBeforeDispatch` for (S, C). Client handler
 *      suspends on `Deferred.await(release)` (lease-acquisition gate).
 *   2. Server sends `apps/onBeforeMessageDelivery` for the SAME (S, C)
 *      whose response would resolve `release`.
 *   3. Single-fiber dispatchers (the pre-#356 `Stream.runForEach`)
 *      queue (2) behind (1) — the release that would unblock (1) is
 *      itself blocked on (1). Self-deadlock.
 *   4. A correct dispatcher resolves: (2) runs to completion; the
 *      `Deferred` fires; (1) resumes and replies.
 *
 * ─── Implementation status (impl-staff #356) ────────────────────────
 *
 * The properties P1-P4 below are the cross-implementation contract.
 * They are NOT registered with the conformance property registry in
 * this PR because cross-impl execution requires the conformance
 * `TestServer` to emit appCallback request frames — a surface addition the
 * architect plan §6 ("No public-package-barrel change. No public
 * surface change to pre-existing modules.") explicitly excluded
 * from the spec's scope.
 *
 * Until that infrastructure lands, the same properties are exercised
 * at lower layers against the reference client implementation
 * (`@moltzap/client`):
 *
 *   - **P1 (disjoint-key concurrency)** —
 *     `packages/client/src/internal/__tests__/app-callback-partitioned-dispatcher.test.ts`
 *     `"two offers with different keys execute concurrently"`.
 *
 *   - **P2 (arena#248 reproducer)** —
 *     `packages/client/src/internal/__tests__/app-callback-partitioned-dispatcher.test.ts`
 *     `"before_dispatch suspended on Deferred.await does NOT block
 *     before_message_delivery for the same (taskId, conversationId)"`
 *     and the real-WS integration test in
 *     `app-callback-partitioned-dispatcher-real-ws.test.ts`.
 *
 *   - **P3 (same-key FIFO)** —
 *     `app-callback-partitioned-dispatcher.test.ts` `"two offers with the same
 *     key land on the same worker (FIFO preserved)"` and the per-tuple
 *     ordering assertion in `app-callback-partition-worker.test.ts`.
 *
 *   - **P4 (per-partition backpressure independence)** —
 *     `app-callback-partitioned-dispatcher.test.ts` `"partitionQueueFull on
 *     partition A does not block partition B"`.
 *
 * The vitest stubs below remain as documentation for the future
 * cross-implementation wiring; they are NOT executed (vitest's
 * include glob is `*.test.ts`, this file is `*.ts`).
 *
 * Routing the deferred work: a follow-up issue should expand
 * `TestServer` with `emitServerRequest` and register these as
 * `dispatcher-concurrency` category properties via the conformance
 * registry, parallel to `boundary` / `delivery`.
 */
import { describe, it } from "vitest";

describe("conformance: appCallback dispatcher concurrency", () => {
  it.todo(
    "P1: two appCallback requests with disjoint (taskId, conversationId, hookKind) " +
      "keys complete concurrently when the first's handler suspends on a Deferred",
  );
  it.todo(
    "P2 (arena#248 reproducer): suspended apps/onBeforeDispatch does NOT block " +
      "apps/onBeforeMessageDelivery for the same (taskId, conversationId); the " +
      "release path resolves and the suspended fiber resumes",
  );
  it.todo(
    "P3: two appCallback requests with identical key are serialized — second handler " +
      "starts only after first handler's Effect completes (FIFO within tuple)",
  );
  it.todo(
    "P4: per-partition backpressure — flooding one (taskId, conversationId, " +
      "hookKind) does NOT delay handler dispatch for any other tuple",
  );
});
