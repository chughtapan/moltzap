/** @file Invocation identity survives concurrency, request cancellation and restart. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Deferred, Effect, Fiber, Schema, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { CollectiveId, SendInput } from "../transport/collectives/forms.js";
import { openEndpointStore } from "../transport/history/index.js";
import { SendError } from "../transport/messaging/errors.js";
import { makeSendInvocations } from "./send-invocations.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Invocation execution counts are independent replay regression expectations. */

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

const joinsAndRetainsIdentity = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* temporaryDirectory.pipe(
          Effect.flatMap(openEndpointStore),
        );
        const scope = yield* Scope.Scope;
        const test = yield* invocationFixture(store, scope);
        const { invocations, started, complete } = test;
        expect(yield* invocations.readSend({ idempotencyKey: "once" })).toEqual(
          { state: "absent" },
        );
        const request = { input, idempotencyKey: "once" };
        const disconnected = yield* invocations
          .send(request)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(disconnected);
        expect(yield* invocations.readSend({ idempotencyKey: "once" })).toEqual(
          { state: "pending", input },
        );
        const retry = yield* invocations.send(request).pipe(Effect.forkScoped);
        const conflict = yield* invocations
          .send({
            ...request,
            input: Schema.decodeUnknownSync(SendInput)({
              to: "agent:bob",
              text: "different",
            }),
          })
          .pipe(Effect.flip);
        expect(conflict).toMatchObject({ reason: "idempotency-conflict" });
        yield* Deferred.succeed(complete, undefined);
        expect(yield* Fiber.join(retry)).toEqual({ operationId });
        expect(yield* invocations.send(request)).toEqual({ operationId });
        expect(test.calls()).toBe(1);
        yield* checksRetainedOutcome(store, scope, request);
        yield* invocations.send({ input });
        yield* invocations.send({ input });
        expect(test.calls()).toBe(3);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
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
      for (let count = 0; count < 2; count += 1) {
        expect(
          yield* invocations
            .send({ input, idempotencyKey: "failure" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "certification-unavailable" });
      }
      expect(calls).toBe(1);
      expect(
        yield* invocations.readSend({ idempotencyKey: "failure" }),
      ).toEqual({
        state: "returned",
        input,
        outcome: {
          kind: "failure",
          error: { reason: "certification-unavailable" },
        },
      });
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

// @agent-code-guard/regression-only: these crash and concurrency transcripts pin the invocation contract without asserting collective completion.
describe("durable send invocations", () => {
  it(
    "joins concurrent retries, survives caller cancellation and retains the collective id",
    joinsAndRetainsIdentity,
  );
  it(
    "leaves interrupted sends indeterminate and replays observed failures",
    preservesUncertaintyAndFailure,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
