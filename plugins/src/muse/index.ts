/** @file Muse's credential-free hook hands an immutable work reference to a started native worker. */

import { FileSystem } from "@effect/platform";
import { Clock, Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { NativeWakeError, type NativeWakeup } from "../native/index.js";
import { type MuseWork, readOptionalFile, writeWork } from "./work.js";

/** Credential-free native commands; neither operation contacts or acknowledges Client. */
export { acceptMuseWork, detectMuseWork } from "./worker.js";

/**
 * Publishes a non-secret reference while Client retains its consumer and lease.
 * Only a started worker's matching acceptance completes this handoff. Detector
 * output alone cannot acknowledge a message. A crash may cause another wake for
 * the same event; callers must not assume exactly-once model execution.
 *
 * ```mermaid
 * flowchart TD
 *   Client[Client delivery] --> Reference[Local event and attempt reference]
 *   Reference --> Hook[Credential-free Muse hook]
 *   Hook --> Worker[Started native worker reads canonical event]
 *   Worker --> Confirmation[Confirm matching attempt]
 *   Confirmation --> Handoff[Return acceptance to Client receive loop]
 * ```
 *
 * @param directory Persistent runtime directory shared with the native hook and worker.
 * @returns A handoff that waits up to five minutes without owning message transport.
 */
export const makeMuseWakeup = Effect.fn("Muse.makeWakeup")(function* (
  directory: string,
) {
  if (!isAbsolute(directory)) {
    return yield* Effect.fail(
      new NativeWakeError({ reason: "invalid-configuration" }),
    );
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
    Effect.catchTags({
      BadArgument: () =>
        Effect.fail(new NativeWakeError({ reason: "invalid-configuration" })),
      SystemError: () =>
        Effect.fail(new NativeWakeError({ reason: "invalid-configuration" })),
    }),
  );
  const wake: NativeWakeup = (delivery) =>
    awaitWorker(fs, directory, delivery.eventId).pipe(
      Effect.scoped,
      Effect.catchTags({
        BadArgument: () =>
          Effect.fail(new NativeWakeError({ reason: "transport-failed" })),
        SystemError: () =>
          Effect.fail(new NativeWakeError({ reason: "transport-failed" })),
        ParseError: () =>
          Effect.fail(new NativeWakeError({ reason: "decode-failed" })),
      }),
      Effect.timeoutFail({
        duration: "5 minutes",
        onTimeout: () => new NativeWakeError({ reason: "timed-out" }),
      }),
    );
  return wake;
});

function awaitWorker(
  fs: FileSystem.FileSystem,
  directory: string,
  eventId: string,
) {
  return Effect.gen(function* () {
    const attempt = yield* Effect.sync(randomUUID);
    const path = join(directory, attempt);
    yield* Effect.acquireRelease(fs.makeDirectory(path, { mode: 0o700 }), () =>
      fs
        .remove(path, { recursive: true, force: true })
        .pipe(
          Effect.catchAll(() =>
            Effect.logWarning("Muse work-reference cleanup failed"),
          ),
        ),
    );
    const work: MuseWork = {
      attempt,
      eventId,
      expiresAt: (yield* Clock.currentTimeMillis) + 300_000,
    };
    yield* writeWork(fs, path, work);
    yield* readOptionalFile(fs, join(path, "accepted")).pipe(
      Effect.map((accepted) => accepted === eventId),
      Effect.repeat({
        schedule: Schedule.spaced("250 millis"),
        until: (accepted) => accepted,
      }),
    );
  });
}
