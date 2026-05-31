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
import { Cause, Effect, Exit, Option, Scope } from "effect";
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

// ── Defect-injection ordering ─────────────────────────────────────────────
//
// The public `client.close()` channel is typed `Effect<void, never>` and
// `Scope.close` itself returns `Effect<void, never>`, so neither side can
// raise a TYPED failure — `Effect.fail` injection is rejected by tsc. The
// load-bearing ordering claim ("scope failure does not skip client, client
// failure does not skip scope") is therefore exercised with DEFECTS
// (`Effect.die`), which `Effect.zipRight` propagates unconditionally and
// which we observe via `Effect.exit` / `Cause`. These tests pin the ACTUAL
// short-circuit semantics so a future refactor of `composeServiceTeardown`
// can't silently change them.

/** A scope whose finalizer records "scope" and then DIES with `boom`. */
function makeDyingScopeRecorder(events: Array<string>, boom: Error) {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        events.push("scope");
      }).pipe(Effect.zipRight(Effect.die(boom))),
    );
    return scope;
  });
}

function teardownScopeDefectShortCircuitsClient() {
  const boom = new Error("scope finalizer boom");
  return Effect.runPromise(
    Effect.gen(function* () {
      const { events, fakeClient } = makeRecorder();
      const scope = yield* makeDyingScopeRecorder(events, boom);
      const exit = yield* Effect.exit(
        composeServiceTeardown(scope, fakeClient),
      );
      // The scope finalizer ran; its defect propagated through `zipRight`,
      // so `client.close()` was SKIPPED (the defect short-circuits the
      // sequence). This pins that a dying scope does not silently swallow
      // its defect into a successful teardown.
      expect(events).toEqual(["scope"]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.dieOption(exit.cause)).toStrictEqual(Option.some(boom));
      }
    }),
  );
}

/** A client whose `close()` records "client" and then DIES with `boom`. */
function makeDyingClient(
  events: Array<string>,
  boom: Error,
): { readonly close: () => Effect.Effect<void, never> } {
  return {
    close: () =>
      Effect.sync(() => {
        events.push("client");
      }).pipe(Effect.zipRight(Effect.die(boom))),
  };
}

function teardownClientDefectAfterScopeClosed() {
  const boom = new Error("client close boom");
  return Effect.runPromise(
    Effect.gen(function* () {
      const events: Array<string> = [];
      const scope = yield* makeScopeRecorder(events);
      const dyingClient = makeDyingClient(events, boom);
      const exit = yield* Effect.exit(
        composeServiceTeardown(scope, dyingClient),
      );
      // Scope closed normally FIRST ("scope"), THEN the client defect
      // surfaced ("client" recorded before it died). The scope teardown is
      // not skipped by the client defect — ordering is preserved and the
      // defect propagates to the exit.
      expect(events).toEqual(["scope", "client"]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.dieOption(exit.cause)).toStrictEqual(Option.some(boom));
      }
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
  it(
    "scope defect short-circuits client.close() (zipRight propagates the die)",
    teardownScopeDefectShortCircuitsClient,
  );
  it(
    "client.close() defect surfaces after scope.close() completes",
    teardownClientDefectAfterScopeClosed,
  );
});
