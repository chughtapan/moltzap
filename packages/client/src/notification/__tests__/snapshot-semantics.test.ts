/**
 * Snapshot-semantics property test (validates AD1 via spec #222 §5.3 OQ-3
 * acceptance criterion).
 *
 * Spec #596 AC: "For any subscription `s` cancelled at time T, no
 * notification with arrival time > T is delivered through `s`."
 *
 * Architect-mandated shape: a property test using fast-check generators
 * (the workspace's standard property-test framework, already imported in
 * the existing `subscribers.test.ts`). Impl-staff fills the body per the
 * pattern below.
 *
 * **Architect stub** (Spec B). The `it.todo` block names the property;
 * impl-staff replaces with `it(..., () => { ... })` and writes the
 * harness.
 */
import { describe, it } from "vitest";

describe("AD1 snapshot semantics — Stream cancellation", () => {
  it.todo(
    "no notification with arrival time > T_cancel is delivered through s",
    // Impl-staff harness outline:
    //   1. Construct a registry + fake reader fiber.
    //   2. Property-generate a sequence of (arrival-time, payload) pairs.
    //   3. Subscribe twice: s_observer (never cancels) and s_target
    //      (cancels at time T = uniform(0, max(arrival_times))).
    //   4. Drive the reader fiber to emit each frame at its arrival-time.
    //   5. Assert: every frame in s_target's observed sequence has
    //      arrival_time <= T_cancel_commit, where T_cancel_commit is the
    //      time the unregister Ref.update committed (instrumented via a
    //      Ref-update probe on subsRef).
    //   6. Assert: s_observer received every frame regardless of s_target's
    //      cancellation (snapshot semantic is per-subscription).
  );

  it.todo(
    "in-flight dispatch of frame N is not interrupted by unsubscribe during frame N",
    // Impl-staff harness outline:
    //   1. Construct registry with 3 subscribers ordered s1, s2, s3.
    //   2. Begin dispatch(frame N) — assert snapshot includes all three.
    //   3. Mid-iteration (after s1, before s2), trigger s2's unsubscribe.
    //   4. Assert: dispatch still offers to s2's queue (snapshot semantic).
    //   5. Assert: dispatch still offers to s3's queue (iteration continues).
    //   6. Begin dispatch(frame N+1) — assert snapshot excludes s2.
  );

  it.todo(
    "closed client terminates all in-flight Streams with NotConnectedError",
    // Impl-staff harness outline:
    //   1. Subscribe; consume via Stream.runForEach forked in a scope.
    //   2. Call client.close().
    //   3. Assert: the forked fiber's exit is a Failure carrying
    //      NotConnectedError.
  );
});
