/**
 * Filter-equivalence oracle (spec #596 §Acceptance criteria).
 *
 * For any property-generated sequence of inbound notifications (length up
 * to 32, value pool size up to 8) and any property-generated typed
 * predicate `p`, the Stream-based API output sequence equals
 * `notifications.filter(n => p(n.params))` restricted to frames whose
 * `name` matches the subscribed definition.
 *
 * The oracle is a pure-JS reference implementation embedded in this file
 * (NOT a reference to the deleted three-storage shape). If a regression
 * fixture of the pre-Spec-B behavior is needed, capture it as a vendored
 * JSON file at `packages/client/src/__tests__/notification-oracle.test.json`
 * per spec AC.
 *
 * **Architect stub** (Spec B). Impl-staff fills the body.
 */
import { describe, it } from "vitest";

describe("Spec B filter-equivalence oracle", () => {
  it.todo(
    "Stream output equals the pure-JS filter oracle for arbitrary inputs",
    // Impl-staff harness outline:
    //   import fc from "fast-check";
    //   const arbNotification = fc.record({
    //     name: fc.constantFrom("notifA", "notifB"),
    //     params: fc.record({ id: fc.integer({ min: 0, max: 7 }) }),
    //   });
    //   const arbSequence = fc.array(arbNotification, { maxLength: 32 });
    //   const arbPredicate = fc.func(fc.boolean());  // pure predicate p
    //   await fc.assert(
    //     fc.asyncProperty(arbSequence, arbPredicate, async (seq, p) => {
    //       const oracle = seq.filter(n => n.name === def.name && p(n.params));
    //       const observed = await runStreamAgainst(seq, def, p);
    //       expect(observed).toEqual(oracle);
    //     }),
    //   );
  );

  it.todo(
    "Type-guard refinement narrows Stream payload",
    // Impl-staff harness outline:
    //   const isGreeting = (p: NotificationParamsOf<D>): p is GreetingParams =>
    //     "greeting" in p;
    //   const s = client.subscribe(def, isGreeting);
    //   // compile-time: Stream.Stream<DecodedNotification<D, GreetingParams>, …>
    //   // runtime: assert only frames whose params pass isGreeting are delivered
  );
});
