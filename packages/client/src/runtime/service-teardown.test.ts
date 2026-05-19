/**
 * Spec B (#596) close-ordering regression test (P2-4 r1 cleanup).
 *
 * `MoltZapService.close` MUST close the service-owned scope (which holds
 * the `subscribeAll → Stream.runForEach` fan-out fiber) BEFORE invoking
 * the ws-client's `close()`. Codex r0 caught the original two-`runFork`
 * race; the structural fix lives in `composeServiceTeardown` and these
 * tests pin the ordering so a future refactor can't regress.
 *
 * `composeServiceTeardown` is a pure Effect producer: it composes the
 * close chain but does NOT run it. The tests await the returned Effect
 * via `yield*`, which means by the time we read `events` the chain has
 * fully settled — no `Effect.runFork` race in the test harness either.
 */
/* eslint-disable agent-code-guard/finalizer-requires-scope -- scope is the test artifact closed explicitly via composeServiceTeardown(scope, ...); no enclosing Effect.scoped frame applies here by design */
import { describe, expect, it } from "vitest";
import { Effect, Scope } from "effect";
import { composeServiceTeardown } from "./service-teardown.js";

interface CloseRecorder {
  readonly events: Array<string>;
  readonly fakeClient: { readonly close: () => Effect.Effect<void, never> };
}

function makeRecorder(): CloseRecorder {
  const events: Array<string> = [];
  const fakeClient = {
    close: () =>
      Effect.sync(() => {
        events.push("client");
      }),
  };
  return { events, fakeClient };
}

function makeScopeRecorder(events: Array<string>) {
  // Build a `Scope.CloseableScope` whose finalizer pushes "scope" — mirrors
  // the runtime shape (the fan-out fiber is installed as a finalizer on
  // `serviceScope` via `Effect.forkIn` in `MoltZapService.connect`). The
  // scope is the artifact under test and is closed explicitly via
  // `composeServiceTeardown`; no enclosing `Effect.scoped` is needed.
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        events.push("scope");
      }),
    );
    return scope;
  });
}

function teardownOrderingCloses() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { events, fakeClient } = makeRecorder();
      const scope = yield* makeScopeRecorder(events);
      yield* composeServiceTeardown(scope, fakeClient);
      expect(events).toEqual(["scope", "client"]);
    }),
  );
}

function teardownNullScopeRunsClient() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { events, fakeClient } = makeRecorder();
      yield* composeServiceTeardown(null, fakeClient);
      expect(events).toEqual(["client"]);
    }),
  );
}

function teardownNullClientClosesScope() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const events: Array<string> = [];
      const scope = yield* makeScopeRecorder(events);
      yield* composeServiceTeardown(scope, null);
      expect(events).toEqual(["scope"]);
    }),
  );
}

function teardownBothNullIsNoop() {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* composeServiceTeardown(null, null);
      // The Effect completed without failing — that IS the assertion. The
      // explicit expect anchors the test name; no value to compare beyond
      // "no throw."
      expect(true).toBe(true);
    }),
  );
}

describe("composeServiceTeardown — Spec B close ordering (P2-4)", () => {
  it(
    "closes service-owned scope BEFORE invoking ws-client.close()",
    teardownOrderingCloses,
  );
  it(
    "tolerates null scope (calls only client.close())",
    teardownNullScopeRunsClient,
  );
  it(
    "tolerates null client (closes only the scope)",
    teardownNullClientClosesScope,
  );
  it("no-op when both inputs are null", teardownBothNullIsNoop);
});
