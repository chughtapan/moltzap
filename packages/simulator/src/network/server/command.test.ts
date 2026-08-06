import { platform } from "node:os";
import { dirname } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Deferred, Duration, Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, it } from "vitest";
import {
  escalatingKill,
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

describe("controller router process command", () => {
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
