/** @file The native hook detects references; an actual started worker confirms its own attempt. */

import { FileSystem } from "@effect/platform";
import { Clock, Effect, Schema } from "effect";
import { join } from "node:path";
import { NativeWakeError } from "../native/index.js";
import {
  createMarker,
  type MuseWork,
  readOptionalFile,
  readWork,
} from "./work.js";

/**
 * Returns newly announced work references, or an empty list on an idle tick.
 * No credentials, network calls, message content or Client acknowledgments are
 * available to the detector. Expired references from a killed receiver are silent.
 */
export const detectMuseWork = Effect.fn("Muse.detectWork")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs.readDirectory(directory).pipe(
    Effect.catchTag("SystemError", (error) =>
      error.reason === "NotFound"
        ? Effect.succeed([])
        : Effect.fail(new NativeWakeError({ reason: "transport-failed" })),
    ),
    Effect.catchTag("BadArgument", () =>
      Effect.fail(new NativeWakeError({ reason: "transport-failed" })),
    ),
  );
  const now = yield* Clock.currentTimeMillis;
  const references = yield* Effect.forEach(
    names
      .filter(Schema.is(Schema.UUID))
      .sort((left, right) => left.localeCompare(right)),
    (attempt) => announceWork(fs, join(directory, attempt), attempt, now),
    { concurrency: 1 },
  );
  return references.filter((work): work is MuseWork => work !== undefined);
});

/**
 * Confirms custody after the native worker has read the canonical event.
 * The exact attempt and event must still be live; a delayed worker cannot
 * confirm a replacement. Repeating the same confirmation is harmless.
 */
export const acceptMuseWork = Effect.fn("Muse.acceptWork")(function* (
  directory: string,
  attempt: string,
  eventId: string,
) {
  const validAttempt = yield* Schema.decodeUnknown(Schema.UUID)(attempt).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new NativeWakeError({ reason: "refused" })),
    ),
  );
  const fs = yield* FileSystem.FileSystem;
  const path = join(directory, validAttempt);
  const work = yield* readWork(fs, path);
  const now = yield* Clock.currentTimeMillis;
  if (
    work === undefined ||
    work.attempt !== attempt ||
    work.eventId !== eventId ||
    work.expiresAt <= now
  ) {
    return yield* Effect.fail(new NativeWakeError({ reason: "refused" }));
  }
  const marker = join(path, "accepted");
  const created = yield* createMarker(fs, marker, eventId);
  if (!created && (yield* readOptionalFile(fs, marker)) !== eventId) {
    return yield* Effect.fail(new NativeWakeError({ reason: "refused" }));
  }
});

function announceWork(
  fs: FileSystem.FileSystem,
  path: string,
  attempt: string,
  now: number,
) {
  return Effect.gen(function* () {
    const work = yield* readWork(fs, path);
    if (
      work === undefined ||
      work.attempt !== attempt ||
      work.expiresAt <= now
    ) {
      return undefined;
    }
    return (yield* createMarker(fs, join(path, "announced"), ""))
      ? work
      : undefined;
  });
}
