/** @file Credential-free native hook and worker commands for a packaged Muse installation. */

import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Config, Console, Effect } from "effect";
import { NativeWakeError } from "../native/index.js";
import { acceptMuseWork, detectMuseWork } from "./index.js";

const command = Effect.gen(function* () {
  const operation = yield* Config.literal(
    "detect",
    "accept",
  )("MOLTZAP_MUSE_OPERATION");
  const directory = yield* Config.string("MOLTZAP_MUSE_STATE_DIR");
  if (operation === "accept") {
    const attempt = yield* Config.string("MOLTZAP_MUSE_ATTEMPT");
    const eventId = yield* Config.string("MOLTZAP_MUSE_EVENT_ID");
    return yield* acceptMuseWork(directory, attempt, eventId);
  }
  const references = yield* detectMuseWork(directory);
  yield* Effect.forEach(
    references,
    (reference) => Console.log(JSON.stringify(reference)),
    { concurrency: 1, discard: true },
  );
}).pipe(
  Effect.catchTag("ConfigError", () =>
    Effect.fail(new NativeWakeError({ reason: "invalid-configuration" })),
  ),
);

if (import.meta.main) {
  command.pipe(Effect.provide(NodeFileSystem.layer), NodeRuntime.runMain);
}
