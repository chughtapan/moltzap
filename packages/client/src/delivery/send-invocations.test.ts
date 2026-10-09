/** @file Invocation identity survives concurrency, request cancellation and restart. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Deferred, Effect, Fiber, Schema, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { EndpointStoreError, openEndpointStore } from "../store/index.js";
import { CollectiveId, SendInput } from "../transport/collectives/forms.js";
import { SendError } from "../transport/messaging/errors.js";
import { makeSendInvocations } from "./send-invocations.js";

const input = Schema.decodeUnknownSync(SendInput)({
  to: "agent:bob",
  text: "one operation",
});
const operationId = Schema.decodeUnknownSync(CollectiveId)(
  `col_${"A".repeat(43)}`,
);
const temporaryDirectory = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped(),
);

const checksRetainedOutcome = (
  store: Parameters<typeof makeSendInvocations>[0],
  scope: Scope.Scope,
  request: Parameters<
    Effect.Effect.Success<ReturnType<typeof makeSendInvocations>>["send"]
  >[0],
) =>
  Effect.gen(function* () {
    const restarted = yield* makeSendInvocations(
      store,
      () => Effect.dieMessage("retained send executed again"),
      scope,
    );
    expect(yield* restarted.send(request)).toEqual({ operationId });
    expect(yield* restarted.readSend({ idempotencyKey: "once" })).toEqual({
      state: "returned",
      input,
      outcome: { kind: "success", result: { operationId } },
    });
  });

const invocationFixture = (
  store: Parameters<typeof makeSendInvocations>[0],
  scope: Scope.Scope,
) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<undefined>();
    const complete = yield* Deferred.make<undefined>();
    let calls = 0;
    const invocations = yield* makeSendInvocations(
      store,
      () =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(
          Effect.zipRight(Deferred.succeed(started, undefined)),
          Effect.zipRight(Deferred.await(complete)),
          Effect.as({ operationId }),
        ),
      scope,
    );
    return { invocations, started, complete, calls: () => calls };
  });

/** The request every keyed test sends, under idempotency key `once`. */
const onceRequest = { input, idempotencyKey: "once" };

const runWithFileSystem = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(NodeFileSystem.layer)),
  );

/** Invocations over a fresh store whose send blocks until `complete` resolves. */
const freshInvocations = Effect.gen(function* () {
  const store = yield* temporaryDirectory.pipe(
    Effect.flatMap(openEndpointStore),
  );
  const scope = yield* Scope.Scope;
  return { store, scope, ...(yield* invocationFixture(store, scope)) };
});

const reportsAnUnseenKeyAsAbsent = () =>
  runWithFileSystem(
    Effect.gen(function* () {
      const { invocations } = yield* freshInvocations;

      expect(yield* invocations.readSend({ idempotencyKey: "once" })).toEqual({
        state: "absent",
      });
    }),
  );

const keepsADisconnectedSendPendingAndJoinsItsRetry = () =>
  runWithFileSystem(
    Effect.gen(function* () {
      const test = yield* freshInvocations;
      const disconnected = yield* test.invocations
        .send(onceRequest)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(test.started);
      yield* Fiber.interrupt(disconnected);
      const pending = yield* test.invocations.readSend({
        idempotencyKey: "once",
      });

      const retry = yield* test.invocations
        .send(onceRequest)
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(test.complete, undefined);

      expect(pending).toEqual({ state: "pending", input });
      expect(yield* Fiber.join(retry)).toEqual({ operationId });
      expect(test.calls()).toBe(1);
    }),
  );

const refusesADifferentInputUnderAKeyInFlight = () =>
  runWithFileSystem(
    Effect.gen(function* () {
      const test = yield* freshInvocations;
      yield* test.invocations.send(onceRequest).pipe(Effect.forkScoped);
      yield* Deferred.await(test.started);

      const conflict = yield* test.invocations
        .send({
          ...onceRequest,
          input: Schema.decodeUnknownSync(SendInput)({
            to: "agent:bob",
            text: "different",
          }),
        })
        .pipe(Effect.flip);

      expect(conflict).toMatchObject({ reason: "idempotency-conflict" });
    }),
  );

const replaysAReturnedOutcomeWithoutSendingAgain = () =>
  runWithFileSystem(
    Effect.gen(function* () {
      const test = yield* freshInvocations;
      yield* Deferred.succeed(test.complete, undefined);
      yield* test.invocations.send(onceRequest);

      const replayed = yield* test.invocations.send(onceRequest);

      expect(replayed).toEqual({ operationId });
      expect(test.calls()).toBe(1);
    }),
  );

const replaysAReturnedOutcomeAfterRestart = () =>
  runWithFileSystem(
    Effect.gen(function* () {
      const test = yield* freshInvocations;
      yield* Deferred.succeed(test.complete, undefined);
      yield* test.invocations.send(onceRequest);

      yield* checksRetainedOutcome(test.store, test.scope, onceRequest);
    }),
  );

const executesEverySendWithoutAKey = () =>
  runWithFileSystem(
    Effect.gen(function* () {
      const test = yield* freshInvocations;
      yield* Deferred.succeed(test.complete, undefined);

      yield* test.invocations.send({ input });
      yield* test.invocations.send({ input });

      expect(test.calls()).toBe(2);
    }),
  );

const interruptsDaemon = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path);
      const scope = yield* Scope.Scope;
      const started = yield* Deferred.make<undefined>();
      const invocations = yield* makeSendInvocations(
        store,
        () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
        scope,
      );
      yield* invocations
        .send({ input, idempotencyKey: "interrupted" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
    }),
  );
/**
 * A keyed send whose execution failed replays that failure to a retry
 * without executing again, and reads back as returned with it.
 */
const checksReplayedFailure = (
  invocations: Effect.Effect.Success<ReturnType<typeof makeSendInvocations>>,
  calls: () => number,
) =>
  Effect.gen(function* () {
    const firstFailure = yield* invocations
      .send({ input, idempotencyKey: "failure" })
      .pipe(Effect.flip);
    const replayedFailure = yield* invocations
      .send({ input, idempotencyKey: "failure" })
      .pipe(Effect.flip);
    expect(firstFailure).toMatchObject({
      reason: "certification-unavailable",
    });
    expect(replayedFailure).toMatchObject({
      reason: "certification-unavailable",
    });
    expect(calls()).toBe(1);
    expect(yield* invocations.readSend({ idempotencyKey: "failure" })).toEqual({
      state: "returned",
      input,
      outcome: {
        kind: "failure",
        error: { reason: "certification-unavailable" },
      },
    });
  });

const checksRestart = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path);
      const scope = yield* Scope.Scope;
      let calls = 0;
      const invocations = yield* makeSendInvocations(
        store,
        () =>
          Effect.sync(() => {
            calls += 1;
          }).pipe(
            Effect.zipRight(
              Effect.fail(
                new SendError({ reason: "certification-unavailable" }),
              ),
            ),
          ),
        scope,
      );
      expect(
        yield* invocations.readSend({ idempotencyKey: "interrupted" }),
      ).toEqual({ state: "indeterminate", input });
      expect(
        yield* invocations
          .send({ input, idempotencyKey: "interrupted" })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "outcome-unknown" });
      expect(calls).toBe(0);
      yield* checksReplayedFailure(invocations, () => calls);
    }),
  );
const preservesUncertaintyAndFailure = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* temporaryDirectory;
        yield* interruptsDaemon(path);
        yield* checksRestart(path);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

const replaysARefusalWithItsDetail = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* temporaryDirectory;
        const store = yield* openEndpointStore(path);
        const scope = yield* Scope.Scope;
        const refusal = new SendError({
          reason: "unknown-agent",
          detail: "agent:dana is not a known agent",
        });
        const invocations = yield* makeSendInvocations(
          store,
          () => Effect.fail(refusal),
          scope,
        );
        yield* invocations
          .send({ input, idempotencyKey: "refused" })
          .pipe(Effect.flip);

        const replayed = yield* invocations
          .send({ input, idempotencyKey: "refused" })
          .pipe(Effect.flip);

        expect(replayed.message).toBe(refusal.message);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

/**
 * A keyed send that posted, whose outcome the store cannot retain, still
 * returns its result rather than a storage reason that says it was not sent.
 * A later lookup of the key reads `outcome-unknown`, since nothing was
 * retained.
 */
const returnsTheOwnOutcomeWhenItCannotBeRetained = () =>
  runWithFileSystem(
    Effect.gen(function* () {
      const store = yield* temporaryDirectory.pipe(
        Effect.flatMap(openEndpointStore),
      );
      const invocations = yield* makeSendInvocations(
        {
          ...store,
          finishSendAttempt: () =>
            Effect.fail(new EndpointStoreError({ reason: "persistence" })),
        },
        () => Effect.succeed({ operationId }),
        yield* Scope.Scope,
      );

      expect(yield* invocations.send(onceRequest)).toEqual({ operationId });
      expect(
        yield* invocations.send(onceRequest).pipe(Effect.flip),
      ).toStrictEqual(new SendError({ reason: "outcome-unknown" }));
    }),
  );

/**
 * A retained outcome the store cannot decode says nothing about whether the
 * send posted, so its key replays as `outcome-unknown`.
 */
const replaysAnUndecodableOutcomeAsUnknown = () =>
  runWithFileSystem(
    Effect.gen(function* () {
      const store = yield* temporaryDirectory.pipe(
        Effect.flatMap(openEndpointStore),
      );
      const scope = yield* Scope.Scope;
      const first = yield* makeSendInvocations(
        store,
        () => Effect.succeed({ operationId }),
        scope,
      );
      yield* first.send(onceRequest);
      const corrupted = yield* makeSendInvocations(
        {
          ...store,
          readSendAttempt: (key) =>
            store
              .readSendAttempt(key)
              .pipe(
                Effect.map((attempt) =>
                  attempt === undefined
                    ? attempt
                    : { ...attempt, canonicalOutcome: Uint8Array.of(0xff) },
                ),
              ),
        },
        () => Effect.dieMessage("retained send executed again"),
        scope,
      );

      expect(
        yield* corrupted.send(onceRequest).pipe(Effect.flip),
      ).toStrictEqual(new SendError({ reason: "outcome-unknown" }));
    }),
  );

// @agent-code-guard/regression-only: these crash and concurrency transcripts pin the invocation contract without asserting collective completion.
describe("durable send invocations", () => {
  it(
    "reports an idempotency key it has not seen as absent",
    reportsAnUnseenKeyAsAbsent,
  );
  it(
    "keeps a send pending when its caller disconnects, and a retry joins it",
    keepsADisconnectedSendPendingAndJoinsItsRetry,
  );
  it(
    "refuses a different input under a key still in flight",
    refusesADifferentInputUnderAKeyInFlight,
  );
  it(
    "replays a returned outcome without executing the send again",
    replaysAReturnedOutcomeWithoutSendingAgain,
  );
  it(
    "replays a returned outcome with its collective id after restart",
    replaysAReturnedOutcomeAfterRestart,
  );
  it(
    "executes every send that names no idempotency key",
    executesEverySendWithoutAKey,
  );
  it(
    "leaves interrupted sends indeterminate and replays observed failures",
    preservesUncertaintyAndFailure,
  );
  it("replays a refusal with its detail", replaysARefusalWithItsDetail);
  it(
    "returns a keyed send's own outcome when the store cannot retain it",
    returnsTheOwnOutcomeWhenItCannotBeRetained,
  );
  it(
    "replays an outcome the store cannot decode as outcome-unknown",
    replaysAnUndecodableOutcomeAsUnknown,
  );
});
