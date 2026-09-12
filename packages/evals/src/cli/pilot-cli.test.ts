/** @file The pilot executable must retain a failed outcome when interrupted. */
import { Command, FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import type { PilotPlan } from "./pilot.js";

const processWait = "15 seconds";
const testTimeout = 45_000;

// @agent-code-guard/regression-only: a real CLI signal pins exit status, retained failure evidence, and native child cleanup across NodeRuntime teardown.
it.scopedLive(
  "SIGTERM exits nonzero, retains failure evidence, and stops the native child",
  () =>
    Effect.gen(function* () {
      const { fs, plan, planPath, cliPath, loaderPath } = yield* fixture();
      const cli = yield* Command.start(
        Command.make(
          process.execPath,
          "--import",
          loaderPath,
          cliPath,
          "--plan",
          planPath,
        ).pipe(Command.stdout("inherit"), Command.stderr("inherit")),
      );
      yield* waitForNative(fs, plan.output);
      const nativeStdout = yield* fs.readFileString(`${plan.output}/stdout`);
      const nativePid = yield* Schema.decodeUnknown(Schema.NumberFromString)(
        nativeStdout.replace("READY ", "").trim(),
      );
      yield* Effect.addFinalizer(() =>
        nativeProcess(nativePid, "SIGKILL").pipe(Effect.ignore),
      );

      yield* cli.kill("SIGTERM");
      const exitCode = yield* cli.exitCode.pipe(Effect.timeout(processWait));
      const failureExists = yield* fs.exists(`${plan.output}/failure.json`);
      const nativeGone = yield* nativeProcess(nativePid, 0);

      assert.notStrictEqual(exitCode, 0, "interrupted CLI reported success");
      assert.isTrue(
        failureExists,
        "interruption has no terminal failure evidence",
      );
      assert.strictEqual(nativeGone, 0, "native child survived CLI teardown");
      const failure: unknown = JSON.parse(
        yield* fs.readFileString(`${plan.output}/failure.json`),
      );
      assert.propertyVal(failure, "suite", "propagation");
      assert.property(failure, "error");
      assert.include(nativeStdout, "READY ");
    }).pipe(Effect.provide(NodeContext.layer)),
  testTimeout,
);

function fixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const source = `${root}/source`;
    const revision = yield* initializeSource(fs, source);
    const plan: PilotPlan = {
      suite: "propagation",
      source: {
        root: source,
        repository: "example/fixture",
        revision: revision.trim(),
      },
      operation: "verify",
      executable: process.execPath,
      args: [
        "-e",
        "console.log('READY '+process.pid);setTimeout(()=>{},30000)",
      ],
      output: `${root}/attempt`,
    };
    const planPath = `${root}/plan.json`;
    yield* fs.writeFileString(planPath, JSON.stringify(plan));
    const cliPath = yield* paths.fromFileUrl(
      new URL("./pilot-cli.ts", import.meta.url),
    );
    const loaderPath = yield* paths.fromFileUrl(
      new URL("../../../../node_modules/tsx/dist/loader.mjs", import.meta.url),
    );
    return { fs, plan, planPath, cliPath, loaderPath };
  });
}

function initializeSource(fs: FileSystem.FileSystem, source: string) {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(source);
    yield* Command.exitCode(
      Command.make("git", "init", "-q", "-b", "main", source),
    );
    yield* fs.writeFileString(`${source}/input`, "fixture");
    yield* Command.exitCode(Command.make("git", "-C", source, "add", "input"));
    yield* Command.exitCode(
      Command.make(
        "git",
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture",
      ),
    );
    return yield* Command.string(
      Command.make("git", "-C", source, "rev-parse", "HEAD"),
    );
  });
}

/** Wait for observed execution, so a slow startup cannot signal the runtime too early. */
function waitForNative(fs: FileSystem.FileSystem, output: string) {
  return fs.readFileString(`${output}/stdout`).pipe(
    Effect.catchTag("SystemError", (error) =>
      error.reason === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (text) => /^READY \d+\n/u.test(text),
    }),
    Effect.timeoutFail({
      duration: processWait,
      onTimeout: () => new Error("native child never emitted its READY marker"),
    }),
  );
}

/** Probe with signal zero; the same process boundary provides best-effort orphan cleanup. */
function nativeProcess(pid: number, signal: 0 | "SIGKILL") {
  return Command.exitCode(
    Command.make(
      process.execPath,
      "-e",
      "try{process.kill(Number(process.argv[1]),JSON.parse(process.argv[2]));process.exitCode=1}catch(error){if(error.code!=='ESRCH')throw error}",
      String(pid),
      JSON.stringify(signal),
    ),
  );
}
