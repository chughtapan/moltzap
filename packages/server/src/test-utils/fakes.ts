/**
 * Layer-based test doubles for server services.
 *
 * Motivation: hand-rolled mock objects (e.g. `vi.spyOn(client, "callSync")`
 * plus ad-hoc `mockResolvedValue`) drift from the real service interface —
 * tests keep passing while production code ships with a different shape.
 * The `sendToAgent` contract drift bug (A7) is the canonical example.
 *
 * These helpers produce test doubles that are *structurally typed against
 * the real service interface*. If the real interface changes, the test
 * double becomes a compile error instead of a silent runtime mismatch.
 *
 * Typed plain-object fakes cover services that tests pass around as
 * instances. Use `makeFakeService&lt;T>()` at the call site so the fake's
 * shape stays tied to the real interface.
 */

import { Data, unsafeCoerce } from "effect";

// ── Generic typed fake factory ─────────────────────────────────────────────

class FakeServiceMethodMissing extends Data.TaggedError(
  "FakeServiceMethodMissing",
)<{
  readonly message: string;
  readonly method: string;
}> {}

/**
 * Build a typed test double for an interface `S` from a partial implementation.
 * The cast is intentional: tests typically implement only the methods the
 * system under test actually calls. Unused methods throw at runtime via the
 * `Proxy` trap so a missing implementation becomes a clear test failure
 * instead of `undefined is not a function`.
 *
 * Because the generic parameter `S` is invariant, TypeScript still enforces
 * that every method you *do* implement matches the real signature — this is
 * the compile-time contract-drift insurance. Adding a field to the real
 * interface does NOT fail compilation (tests are a Partial), but changing an
 * existing field's signature does.
 * @param impl Value supplied to the operation.
 * @returns The created fake service.
 */
export const makeFakeService = <S extends object>(impl: Partial<S>): S =>
  unsafeCoerce<Partial<S>, S>(
    new Proxy(impl, {
      get(target, prop, receiver) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        // Symbol lookups (e.g. Symbol.toPrimitive) — let the default behavior run.
        if (typeof prop === "symbol") {
          return undefined;
        }
        const method = prop;
        throw new FakeServiceMethodMissing({
          message:
            `FakeService: method '${method}' was called but not implemented. ` +
            `Add it to the test double.`,
          method,
        });
      },
    }),
  );
