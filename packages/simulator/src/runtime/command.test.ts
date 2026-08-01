import { execPath } from "node:process";
import { dirname } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Deferred, Duration, Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  escalatingKill,
  makeCommandHelpers,
  makeExactEnvironmentCommand,
  startSupervisedProcess,
} from "./command.js";

const TEST_WORKING_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TEST_PATH = "/usr/bin:/bin";
const TEST_HOME = "/test/home";
const TEST_ALLOWED_VALUE = "visible";
const PRINT_ENVIRONMENT_SCRIPT =
  "console.log(JSON.stringify(Object.entries(process.env).sort()))";
// macOS injects this process-local encoding hint after spawn, so it does not
// represent inherited operator state.
const PLATFORM_INJECTED_ENVIRONMENT_NAMES = new Set([
  "__CF_USER_TEXT_ENCODING",
]);
const EXPECTED_ENVIRONMENT_ENTRIES = [
  ["HOME", TEST_HOME],
  ["PATH", TEST_PATH],
  ["TEST_ALLOWED", TEST_ALLOWED_VALUE],
];
const READY_MARKER = "ready";
const TARGET_TERM_DELAY_MS = 300;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const READY_TIMEOUT_MS = 2_000;
const MINIMUM_GRACEFUL_SHUTDOWN_MS = 200;
const GRACEFUL_TERM_SCRIPT = `
process.on("SIGTERM", () => {
  setTimeout(() => process.exit(0), ${TARGET_TERM_DELAY_MS});
});
process.stdout.write("${READY_MARKER}\\n");
setInterval(() => {}, 1_000);
`;
const SPLIT_UTF8_VALUE = "雪";
const SPLIT_STDOUT = `${SPLIT_UTF8_VALUE}-stdout\n`;
const SPLIT_STDERR = `${SPLIT_UTF8_VALUE}-stderr\n`;
const SPLIT_UTF8_SCRIPT = `
const bytes = Buffer.from("${SPLIT_UTF8_VALUE}");
process.stdout.write(bytes.subarray(0, 1));
setTimeout(() => process.stderr.write(bytes.subarray(0, 1)), 20);
setTimeout(
  () => process.stdout.write(Buffer.concat([
    bytes.subarray(1),
    Buffer.from("-stdout\\n"),
  ])),
  40,
);
setTimeout(
  () => process.stderr.write(Buffer.concat([
    bytes.subarray(1),
    Buffer.from("-stderr\\n"),
  ])),
  60,
);
setTimeout(() => process.exit(0), 100);
`;

// Mirrors a NanoClaw workspace build: npm summarizes the lifecycle failure on
// stderr while the compiler it invoked reports the real cause on stdout.
const BUILD_STDERR_SUMMARY = "npm error Lifecycle script build failed";
const BUILD_STDOUT_DIAGNOSTIC =
  "src/index.ts(1,1): error TS2304: Cannot find name foo.";
const BUILD_EXIT_CODE = 2;
const OVERSIZED_HEAD_MARKER = "OLDEST_OUTPUT_MARKER";
const OVERSIZED_TAIL_MARKER = "NEWEST_OUTPUT_MARKER";
const OVERSIZED_FILLER_CHARS = 64 * 1024;

function nodeScriptCommand(script: string): string {
  return `"${execPath}" -e ${JSON.stringify(script)}`;
}

// A failure reason echoes the command text, so a script that names its expected
// output verbatim would satisfy every assertion below without any output being
// retained. Emitting each string from halves keeps the whole literal reachable
// only through the captured stream.
function emitSplit(stream: "stdout" | "stderr", text: string): string {
  const half = Math.floor(text.length / 2);
  return (
    `process.${stream}.write(${JSON.stringify(text.slice(0, half))} +` +
    ` ${JSON.stringify(text.slice(half))});`
  );
}

const failingBuildCommand = nodeScriptCommand(
  emitSplit("stderr", BUILD_STDERR_SUMMARY) +
    emitSplit("stdout", BUILD_STDOUT_DIAGNOSTIC) +
    `process.exit(${String(BUILD_EXIT_CODE)});`,
);

// The filler fills the stdout pipe, so the tail write queues behind it.
// `process.exit` would terminate before that queue drains and drop the marker
// this test is looking for; setting the code instead lets the write land and
// the process end on its own.
const oversizedOutputCommand = nodeScriptCommand(
  emitSplit("stdout", OVERSIZED_HEAD_MARKER) +
    `process.stdout.write("x".repeat(${String(OVERSIZED_FILLER_CHARS)}));` +
    emitSplit("stdout", OVERSIZED_TAIL_MARKER) +
    `process.exitCode = ${String(BUILD_EXIT_CODE)};`,
);

const { execEffect } = makeCommandHelpers(
  (reason: string) => new Error(reason),
);

function execFailure(commandText: string) {
  return execEffect(commandText).pipe(
    Effect.flip,
    Effect.provide(NodeContext.layer),
  );
}

describe("execEffect", () => {
  it("retains both streams when a build command fails", retainsBothStreams);
  it("keeps the newest output when a command floods", boundsDiagnostics);
  it("stays silent when the command succeeds", succeedsWithoutDiagnostics);
});

function retainsBothStreams() {
  return Effect.runPromise(
    execFailure(failingBuildCommand).pipe(
      Effect.tap((failure) => {
        expect(failure.message).toContain(String(BUILD_EXIT_CODE));
        expect(failure.message).toContain(BUILD_STDERR_SUMMARY);
        expect(failure.message).toContain(BUILD_STDOUT_DIAGNOSTIC);
      }),
      Effect.asVoid,
    ),
  );
}

function boundsDiagnostics() {
  return Effect.runPromise(
    execFailure(oversizedOutputCommand).pipe(
      Effect.tap((failure) => {
        expect(failure.message).toContain(OVERSIZED_TAIL_MARKER);
        expect(failure.message).not.toContain(OVERSIZED_HEAD_MARKER);
        expect(failure.message.length).toBeLessThan(OVERSIZED_FILLER_CHARS);
      }),
      Effect.asVoid,
    ),
  );
}

function succeedsWithoutDiagnostics() {
  return Effect.runPromise(
    execEffect(nodeScriptCommand("process.stdout.write(String(1));")).pipe(
      Effect.provide(NodeContext.layer),
    ),
  );
}

describe("makeExactEnvironmentCommand", () => {
  it(
    "removes the operator environment before executing",
    removesOperatorEnvironment,
  );
  it.skipIf(platform() === "win32")(
    "keeps the launcher alive for the target's graceful TERM window",
    preservesGracefulTermWindow,
  );
  it(
    "reassembles independently fragmented UTF-8 from stdout and stderr",
    preservesFragmentedOutput,
  );
});

function removesOperatorEnvironment() {
  return Effect.runPromise(
    Command.string(
      makeExactEnvironmentCommand({
        command: execPath,
        args: ["-e", PRINT_ENVIRONMENT_SCRIPT],
        cwd: TEST_WORKING_DIRECTORY,
        env: {
          PATH: TEST_PATH,
          HOME: TEST_HOME,
          TEST_ALLOWED: TEST_ALLOWED_VALUE,
        },
      }),
    ).pipe(
      Effect.map(
        (output) =>
          /* Safe because the test fixture establishes this asserted shape. */ JSON.parse(
            output,
          ) as ReadonlyArray<readonly [name: string, value: string]>,
      ),
      Effect.tap((environmentEntries) => {
        expect(
          environmentEntries.filter(
            ([name]) => !PLATFORM_INJECTED_ENVIRONMENT_NAMES.has(name),
          ),
        ).toEqual(EXPECTED_ENVIRONMENT_ENTRIES);
      }),
      Effect.asVoid,
      Effect.provide(NodeContext.layer),
    ),
  );
}

function preservesGracefulTermWindow() {
  return Effect.runPromise(
    Scope.make().pipe(
      Effect.flatMap((scope) =>
        Effect.gen(function* () {
          const ready = yield* Deferred.make<undefined>();
          const supervised = yield* startSupervisedProcess(
            makeGracefulTermCommand(),
            scope,
            (chunk) => {
              if (chunk.includes(READY_MARKER)) {
                Deferred.unsafeDone(ready, Effect.succeed(undefined));
              }
            },
            {
              claimed: false,
              launcherOwnsExitCleanup: true,
            },
          );
          yield* Deferred.await(ready).pipe(
            Effect.timeout(Duration.millis(READY_TIMEOUT_MS)),
          );

          const startedAt = Date.now();
          yield* escalatingKill(
            supervised.proc,
            supervised.exitFiber,
            {
              termWaitMs: TERM_WAIT_MS,
              killWaitMs: KILL_WAIT_MS,
            },
            supervised.processTreeCleanup,
          );
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
            MINIMUM_GRACEFUL_SHUTDOWN_MS,
          );
        }).pipe(Effect.ensuring(Scope.close(scope, Exit.succeed(undefined)))),
      ),
      Effect.provide(NodeContext.layer),
    ),
  );
}

function preservesFragmentedOutput() {
  return Effect.runPromise(
    Scope.make().pipe(
      Effect.flatMap((scope) =>
        Effect.gen(function* () {
          let output = "";
          const complete = yield* Deferred.make<undefined>();
          const supervised = yield* startSupervisedProcess(
            makeSplitUtf8Command(),
            scope,
            (chunk) => {
              output += chunk;
              if (
                output.includes(SPLIT_STDOUT) &&
                output.includes(SPLIT_STDERR)
              ) {
                Deferred.unsafeDone(complete, Effect.succeed(undefined));
              }
            },
          );
          yield* Deferred.await(complete).pipe(
            Effect.timeout(Duration.millis(READY_TIMEOUT_MS)),
          );
          yield* Fiber.join(supervised.exitFiber);
          expect(output).toContain(SPLIT_STDOUT);
          expect(output).toContain(SPLIT_STDERR);
        }).pipe(Effect.ensuring(Scope.close(scope, Exit.succeed(undefined)))),
      ),
      Effect.provide(NodeContext.layer),
    ),
  );
}

function makeGracefulTermCommand() {
  return makeExactEnvironmentCommand({
    command: execPath,
    args: ["-e", GRACEFUL_TERM_SCRIPT],
    cwd: TEST_WORKING_DIRECTORY,
    env: {
      PATH: TEST_PATH,
      HOME: TEST_HOME,
    },
    cleanupTreeOnExit: true,
  });
}

function makeSplitUtf8Command() {
  return makeExactEnvironmentCommand({
    command: execPath,
    args: ["-e", SPLIT_UTF8_SCRIPT],
    cwd: TEST_WORKING_DIRECTORY,
    env: {
      PATH: TEST_PATH,
      HOME: TEST_HOME,
    },
  });
}
