/** @file Real process signals either finish the audit or leave current evidence incomplete. */

import { Command, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Stream } from "effect";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { awaitStage } from "../__tests__/daemon-runtime-harness.js";
import {
  decodeAudit,
  makeAuditFixture,
} from "../__tests__/firewall-audit-fixtures.js";
import { stateDirectory } from "../__tests__/store-schema-fixtures.js";

/** Loader resolution follows Client dependencies even when child processes run from the workspace root. */
const require = createRequire(import.meta.url);

const childProgram = fileURLToPath(
  new URL("../__tests__/firewall-audit-child.ts", import.meta.url),
);
const recoveryProgram = fileURLToPath(
  new URL("../__tests__/firewall-audit-recovery-child.ts", import.meta.url),
);
/**
 * Each child starts cold under tsx and opens its store before it reports
 * `ready`, about 5 s on a 32-core CI host, and the SIGKILL test starts three.
 * Every stage is bounded by the harness's hang bound, so this backstop sits
 * above that bound and above the three starts together.
 */
const PROCESS_TEST_TIMEOUT = 60_000;

function startAuditedChild(
  directory: string,
  block: boolean,
  program = childProgram,
) {
  return Effect.gen(function* () {
    const child = yield* Command.start(
      Command.make(
        process.execPath,
        "--import",
        require.resolve("tsx"),
        program,
      ).pipe(
        Command.stderr("inherit"),
        Command.env({
          SHARNESS_TEST_AUDIT_DIRECTORY: directory,
          SHARNESS_TEST_AUDIT_BLOCK: String(block),
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

function expectPrivateStaging(path: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const trace = (yield* makeAuditFixture).result.checks[0]?.trace;
    expect(trace).toBeDefined();
    const staged = decodeAudit(yield* fileSystem.readFileString(path));
    expect(
      staged.records.find((record) => record.kind === "check"),
    ).toMatchObject({
      kind: "check",
      result: { checks: [{ trace }] },
    });
  });
}

const repeatedKillsRecoverStaging = () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const fileSystem = yield* FileSystem.FileSystem;
    const path = join(directory, "audit.ndjson");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { child, exporting } = yield* startAuditedChild(
        directory,
        true,
        recoveryProgram,
      );
      yield* awaitStage(Deferred.await(exporting), "partial audit write");
      yield* child.kill("SIGKILL");
      const files = yield* fileSystem.readDirectory(directory);
      expect(files.filter((name) => name.endsWith(".partial"))).toEqual([
        "audit.ndjson.partial",
      ]);
      yield* expectPrivateStaging(`${path}.partial`);
      expect(
        decodeAudit(yield* fileSystem.readFileString(path)).records.map(
          (record) => record.kind,
        ),
      ).toEqual(["start"]);
    }
    const { child } = yield* startAuditedChild(
      directory,
      false,
      recoveryProgram,
    );
    expect(yield* child.exitCode).toBe(0);
    expect(yield* fileSystem.exists(`${path}.partial`)).toBe(false);
    const snapshot = decodeAudit(yield* fileSystem.readFileString(path));
    expect(snapshot.records.at(-1)).toMatchObject({
      kind: "complete",
      checkCount: 3,
      sha256: snapshot.sha256,
    });
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
  it(
    "bounds private staging across repeated SIGKILLs and removes it on successful restart",
    repeatedKillsRecoverStaging,
    PROCESS_TEST_TIMEOUT,
  );
});
