import { it as effectIt } from "@effect/vitest";
import { NotConnectedError } from "@moltzap/protocol/rpc";
import { Effect, Exit, Scope } from "effect";
import { describe, expect } from "vitest";
import {
  makeDaemonResourceScopes,
  runScopedActivationAttempt,
} from "./moltzapd.js";

const it = effectIt.scoped;

const recordEvent = (events: string[], event: string) =>
  Effect.sync(() => {
    events.push(event);
  });

const failingActivation = (events: string[]) =>
  Effect.acquireRelease(recordEvent(events, "first acquired"), () =>
    recordEvent(events, "first released"),
  ).pipe(
    Effect.zipRight(
      Effect.fail(
        new NotConnectedError({ message: "first activation cannot connect" }),
      ),
    ),
  );

function verifiesAttemptCleanup() {
  return Effect.gen(function* () {
    const daemonScope = yield* Effect.scope;
    const events: string[] = [];
    const firstExit = yield* Effect.exit(
      runScopedActivationAttempt(daemonScope, failingActivation(events)),
    );
    expect(Exit.isFailure(firstExit)).toBe(true);

    yield* runScopedActivationAttempt(
      daemonScope,
      recordEvent(events, "second acquired"),
    );
    expect(events).toEqual([
      "first acquired",
      "first released",
      "second acquired",
    ]);
  });
}

function verifiesDaemonShutdownOrder() {
  return Effect.gen(function* () {
    const parentScope = yield* Effect.scope;
    const { activationScope, daemonScope } =
      yield* makeDaemonResourceScopes(parentScope);
    const events: string[] = [];
    yield* Effect.acquireRelease(recordEvent(events, "listener acquired"), () =>
      recordEvent(events, "listener released"),
    ).pipe(Scope.extend(daemonScope));
    yield* Effect.acquireRelease(recordEvent(events, "core acquired"), () =>
      recordEvent(events, "core released"),
    ).pipe(Scope.extend(activationScope));

    yield* Scope.close(daemonScope, Exit.void);

    expect(events).toEqual([
      "listener acquired",
      "core acquired",
      "listener released",
      "core released",
    ]);
  });
}

describe("moltzapd activation lifetime", () => {
  it(
    "releases a failed activation before a later attempt begins",
    verifiesAttemptCleanup,
  );
  it(
    "closes the MCP listener before the active channel core",
    verifiesDaemonShutdownOrder,
  );
});
