/**
 * Conformance — s2c dispatcher concurrency invariants.
 *
 * Spec: moltzap#356 §8 (test plan, file 4).
 *
 * Cross-implementation contract: any client that drains s2c request
 * frames MUST run hooks for distinct `(sessionId, conversationId,
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
 * The properties below are written against the boundary
 * `TestClient` + `TestServer` so they apply unchanged to any
 * MoltZap-conforming client. Implementer wires them into
 * `protocol/src/testing/conformance/index.ts` alongside the existing
 * `boundary` / `delivery` tiers.
 *
 * Principle 3: every property body is `Effect<void, PropertyFailure>`.
 */
import { describe, it } from "vitest";

describe("conformance: s2c dispatcher concurrency", () => {
  it.todo(
    "P1: two s2c requests with disjoint (sessionId, conversationId, hookKind) " +
      "keys complete concurrently when the first's handler suspends on a Deferred",
  );
  it.todo(
    "P2 (arena#248 reproducer): suspended apps/onBeforeDispatch does NOT block " +
      "apps/onBeforeMessageDelivery for the same (sessionId, conversationId); the " +
      "release path resolves and the suspended fiber resumes",
  );
  it.todo(
    "P3: two s2c requests with identical key are serialized — second handler " +
      "starts only after first handler's Effect completes (FIFO within tuple)",
  );
  it.todo(
    "P4: per-partition backpressure — flooding one (sessionId, conversationId, " +
      "hookKind) does NOT delay handler dispatch for any other tuple",
  );
});
