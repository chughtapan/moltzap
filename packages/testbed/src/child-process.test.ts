import { execPath } from "node:process";
import { dirname } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Deferred, Duration, Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  escalatingKill,
  makeExactEnvironmentCommand,
  startSupervisedProcess,
} from "./child-process.js";

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

describe("makeExactEnvironmentCommand", () => {
  it(
    "removes the operator environment before executing",
    removesOperatorEnvironment,
  );
  it.skipIf(platform() === "win32")(
    "keeps the launcher alive for the target's graceful TERM window",
    preservesGracefulTermWindow,
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
          JSON.parse(output) as ReadonlyArray<
            readonly [name: string, value: string]
          >,
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
          const ready = yield* Deferred.make<void>();
          const supervised = yield* startSupervisedProcess(
            makeGracefulTermCommand(),
            scope,
            (chunk) => {
              if (chunk.includes(READY_MARKER)) {
                Deferred.unsafeDone(ready, Effect.void);
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
