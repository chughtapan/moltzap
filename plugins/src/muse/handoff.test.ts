/** @file Muse wake custody is tested through real files and the same commands used by its native workers. */

import { FileSystem, type HttpClient } from "@effect/platform";
import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import {
  Effect,
  FastCheck as fc,
  Fiber,
  Option,
  type Scope,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import { acceptMuseWork, detectMuseWork, makeMuseWakeup } from "./index.js";

const eventId = "evt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("Muse native handoff", () => {
  it(
    "is silent without pending work and needs no runtime credential",
    staysIdle,
  );
  it(
    "waits for the worker after announcing one credential-free reference",
    waitsForWorker,
  );
  it("does not accept a different event for a live attempt", rejectsWrongEvent);
  it(
    "rejects an old worker after a replacement receives the same event",
    fencesOldWorker,
  );
  it(
    "emits only one reference when detector invocations overlap",
    announcesOnce,
  );
  it(
    "times out an unaccepted wake and removes its native reference",
    expiresWork,
    15000,
  );
  it("rejects generated path-like attempt identifiers", rejectsInvalidAttempts);
});

function staysIdle() {
  return runInDirectory((directory) =>
    Effect.gen(function* () {
      expect(yield* detectMuseWork(directory)).toEqual([]);
    }),
  );
}

function waitsForWorker() {
  return runInDirectory((directory) =>
    Effect.gen(function* () {
      const wake = yield* makeMuseWakeup(directory);
      const waiting = yield* Effect.forkScoped(wake({ eventId }));
      const work = yield* nextWork(directory);
      expect(work.eventId).toBe(eventId);
      expect(
        Object.keys(work).sort((left, right) => left.localeCompare(right)),
      ).toEqual(["attempt", "eventId", "expiresAt"]);
      expect(yield* detectMuseWork(directory)).toEqual([]);
      expect(Option.isNone(yield* Fiber.poll(waiting))).toBe(true);
      yield* acceptMuseWork(directory, work.attempt, eventId);
      yield* Fiber.join(waiting);
      expect(yield* detectMuseWork(directory)).toEqual([]);
    }),
  );
}

function rejectsWrongEvent() {
  return runInDirectory((directory) =>
    Effect.gen(function* () {
      const wake = yield* makeMuseWakeup(directory);
      const waiting = yield* Effect.forkScoped(wake({ eventId }));
      const work = yield* nextWork(directory);
      const refused = yield* Effect.either(
        acceptMuseWork(directory, work.attempt, "another-event"),
      );
      expect(refused).toMatchObject({
        _tag: "Left",
        left: { reason: "refused" },
      });
      expect(Option.isNone(yield* Fiber.poll(waiting))).toBe(true);
      yield* acceptMuseWork(directory, work.attempt, eventId);
      yield* Fiber.join(waiting);
    }),
  );
}

function fencesOldWorker() {
  return runInDirectory((directory) =>
    Effect.gen(function* () {
      const wake = yield* makeMuseWakeup(directory);
      const oldReceiver = yield* Effect.forkScoped(wake({ eventId }));
      const oldWork = yield* nextWork(directory);
      yield* Fiber.interrupt(oldReceiver);
      const replacement = yield* Effect.forkScoped(wake({ eventId }));
      const work = yield* nextWork(directory);
      expect(work.attempt).not.toBe(oldWork.attempt);
      expect(
        yield* Effect.either(
          acceptMuseWork(directory, oldWork.attempt, eventId),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "refused" } });
      expect(Option.isNone(yield* Fiber.poll(replacement))).toBe(true);
      yield* acceptMuseWork(directory, work.attempt, eventId);
      yield* Fiber.join(replacement);
    }),
  );
}

function announcesOnce() {
  return runInDirectory((directory) =>
    Effect.gen(function* () {
      const wake = yield* makeMuseWakeup(directory);
      const waiting = yield* Effect.forkScoped(wake({ eventId }));
      const references = yield* Effect.all(
        [detectMuseWork(directory), detectMuseWork(directory)],
        { concurrency: 2 },
      ).pipe(
        Effect.map((batches) => batches.flat()),
        Effect.repeat({ until: (batch) => batch.length > 0 }),
      );
      expect(references).toHaveLength(1);
      const work = references[0];
      if (work === undefined) {
        return yield* Effect.dieMessage("Expected native work reference");
      }
      yield* acceptMuseWork(directory, work.attempt, eventId);
      yield* Fiber.join(waiting);
    }),
  );
}

function expiresWork() {
  return runInDirectory((directory) =>
    Effect.gen(function* () {
      const wake = yield* makeMuseWakeup(directory);
      const waiting = yield* Effect.forkScoped(
        Effect.either(wake({ eventId })),
      );
      yield* nextWork(directory);
      yield* TestClock.adjust("5 minutes");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        _tag: "Left",
        left: { reason: "timed-out" },
      });
      expect(yield* detectMuseWork(directory)).toEqual([]);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
}

function rejectsInvalidAttempts() {
  return fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 100 }), rejectsPathAttempt),
    { numRuns: 30 },
  );
}

function rejectsPathAttempt(suffix: string) {
  return runInDirectory((directory) =>
    Effect.gen(function* () {
      expect(
        yield* Effect.either(
          acceptMuseWork(directory, `../${suffix}`, eventId),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "refused" } });
    }),
  );
}

function nextWork(directory: string) {
  return detectMuseWork(directory).pipe(
    Effect.repeat({ until: (references) => references.length > 0 }),
    Effect.flatMap(([work]) =>
      work === undefined
        ? Effect.dieMessage("Expected native work reference")
        : Effect.succeed(work),
    ),
  );
}

function runInDirectory<E>(
  test: (
    directory: string,
  ) => Effect.Effect<
    void,
    E,
    FileSystem.FileSystem | HttpClient.HttpClient | Scope.Scope
  >,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "moltzap-muse-test-",
    });
    yield* test(directory);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeFileSystem.layer),
    Effect.provide(NodeHttpClient.layer),
    Effect.runPromise,
  );
}
