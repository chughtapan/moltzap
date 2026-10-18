/** @file Real process signals either finish the audit or leave current evidence incomplete. */

import { Command, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Stream } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { awaitStage } from "../__tests__/daemon-runtime-harness.js";
import { decodeAudit } from "../__tests__/firewall-audit-fixtures.js";
import { stateDirectory } from "../__tests__/store-schema-fixtures.js";

const childProgram = fileURLToPath(
  new URL("../__tests__/firewall-audit-child.ts", import.meta.url),
);
const PROCESS_TEST_TIMEOUT = 20_000;

function startAuditedChild(directory: string, block: boolean) {
  return Effect.gen(function* () {
    const child = yield* Command.start(
      Command.make(process.execPath, "--import", "tsx", childProgram).pipe(
        Command.stderr("inherit"),
        Command.env({
          MOLTZAP_TEST_AUDIT_DIRECTORY: directory,
          MOLTZAP_TEST_AUDIT_BLOCK: String(block),
        }),
      ),
    );
    yield* Effect.addFinalizer(() => child.kill("SIGKILL").pipe(Effect.ignore));
    const ready = yield* Deferred.make<undefined>();
    const exporting = yield* Deferred.make<undefined>();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        switch (line) {
          case "ready":
            return Deferred.succeed(ready, undefined);
          case "exporting":
            return Deferred.succeed(exporting, undefined);
          default:
            return Effect.void;
        }
      }),
      Effect.forkScoped,
    );
    yield* awaitStage(Deferred.await(ready), "child listener");
    return { child, exporting };
  });
}

const gracefulSignalPublishesSnapshot = () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const { child } = yield* startAuditedChild(directory, false);
    yield* awaitStage(child.kill("SIGTERM"), "graceful child shutdown");
    expect(yield* child.exitCode).toBe(0);
    const fileSystem = yield* FileSystem.FileSystem;
    const { records, sha256 } = decodeAudit(
      yield* fileSystem.readFileString(join(directory, "audit.ndjson")),
    );
    expect(records[1]).toMatchObject({
      kind: "check",
      disposition: "checking",
      result: null,
    });
    expect(records.at(-1)).toMatchObject({
      kind: "complete",
      checkCount: 1,
      sha256,
    });
  }).pipe(Effect.provide(NodeContext.layer));

const forcedSignalLeavesIncomplete = () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const { child, exporting } = yield* startAuditedChild(directory, true);
    yield* child.kill("SIGTERM").pipe(Effect.ignore, Effect.forkScoped);
    yield* awaitStage(Deferred.await(exporting), "shutdown export start");
    yield* child.kill("SIGKILL");
    const fileSystem = yield* FileSystem.FileSystem;
    const { records } = decodeAudit(
      yield* fileSystem.readFileString(join(directory, "audit.ndjson")),
    );
    expect(records.map((record) => record.kind)).toEqual(["start"]);
  }).pipe(Effect.provide(NodeContext.layer));

describe("daemon audit process shutdown", () => {
  it(
    "waits for the snapshot after SIGTERM before exiting",
    gracefulSignalPublishesSnapshot,
    PROCESS_TEST_TIMEOUT,
  );
  it(
    "leaves no published completion after SIGKILL during export",
    forcedSignalLeavesIncomplete,
    PROCESS_TEST_TIMEOUT,
  );
});
