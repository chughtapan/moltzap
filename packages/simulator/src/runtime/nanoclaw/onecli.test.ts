import { Buffer } from "node:buffer";
import { platform } from "node:os";
import { execPath } from "node:process";
import { Command, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Duration, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildExclusiveFileLockProcessPlan,
  runCommandWithExclusiveFileLock,
} from "./onecli.js";

const LOCK_FILE_NAME = "onecli-start.lock";
const LOCK_CONTENTS = "persistent-lock-inode";
const FIRST_CONTENDER = "first";
const SECOND_CONTENDER = "second";
const PROTECTED_COMMAND_DURATION_MS = 200;
const FILE_POLL_INTERVAL_MS = 10;
const TEST_TIMEOUT_MS = 3_000;
const ZERO_EXIT_CODE = 0;
const EXPECTED_FAILURE_EXIT_CODE = 7;
const LOCK_EVENT_SCRIPT = `
const fs = require("node:fs");
const [eventPath, label, durationMs] = process.argv.slice(1);
fs.appendFileSync(eventPath, "start:" + label + "\\n");
setTimeout(() => {
  fs.appendFileSync(eventPath, "end:" + label + "\\n");
}, Number(durationMs));
`;
const MARK_AND_WAIT_SCRIPT = `
require("node:fs").writeFileSync(process.argv[1], "held");
setInterval(() => {}, 0x7fffffff);
`;
const PARENT_CRASH_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const payload = JSON.parse(
  Buffer.from(process.argv[1], "base64url").toString("utf8"),
);
const child = spawn(payload.command, payload.args, {
  detached: true,
  stdio: ["pipe", "ignore", "ignore"],
});
child.unref();
const waitForMarker = () => {
  if (fs.existsSync(payload.markerPath)) {
    process.exit(0);
  }
  setTimeout(waitForMarker, ${FILE_POLL_INTERVAL_MS});
};
waitForMarker();
`;
const FIRST_THEN_SECOND_EVENTS = [
  `start:${FIRST_CONTENDER}`,
  `end:${FIRST_CONTENDER}`,
  `start:${SECOND_CONTENDER}`,
  `end:${SECOND_CONTENDER}`,
];
const SECOND_THEN_FIRST_EVENTS = [
  `start:${SECOND_CONTENDER}`,
  `end:${SECOND_CONTENDER}`,
  `start:${FIRST_CONTENDER}`,
  `end:${FIRST_CONTENDER}`,
];

describe.skipIf(platform() !== "darwin" && platform() !== "linux")(
  "runCommandWithExclusiveFileLock",
  () => {
    it("serializes protected subprocesses", serializesContenders);
    it("uses an existing unlocked lock file", usesExistingUnlockedFile);
    it("releases the lock after command failure", releasesAfterFailure);
    it(
      "releases the lock when its owning fiber is interrupted",
      releasesOnExit,
    );
    it("releases the lock when the parent process crashes", releasesOnCrash);
  },
);

function serializesContenders() {
  return runTest(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const lockPath = `${directory}/${LOCK_FILE_NAME}`;
        const eventPath = `${directory}/events.log`;

        yield* Effect.all(
          [
            runCommandWithExclusiveFileLock(
              { path: lockPath },
              lockEventCommand(eventPath, FIRST_CONTENDER),
            ),
            runCommandWithExclusiveFileLock(
              { path: lockPath },
              lockEventCommand(eventPath, SECOND_CONTENDER),
            ),
          ],
          { concurrency: 2 },
        );

        const events = (yield* fileSystem.readFileString(eventPath))
          .trim()
          .split("\n");
        expect(
          events.join("\n") === FIRST_THEN_SECOND_EVENTS.join("\n") ||
            events.join("\n") === SECOND_THEN_FIRST_EVENTS.join("\n"),
        ).toBe(true);
      }),
    ),
  );
}

function usesExistingUnlockedFile() {
  return runTest(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const lockPath = `${directory}/${LOCK_FILE_NAME}`;
        yield* fileSystem.writeFileString(lockPath, LOCK_CONTENTS);

        yield* runCommandWithExclusiveFileLock(
          { path: lockPath },
          successfulCommand(),
        );

        expect(yield* fileSystem.readFileString(lockPath)).toBe(LOCK_CONTENTS);
      }),
    ),
  );
}

function releasesAfterFailure() {
  return runTest(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const lockPath = `${directory}/${LOCK_FILE_NAME}`;

        const exitCode = yield* runCommandWithExclusiveFileLock(
          { path: lockPath },
          {
            command: execPath,
            args: ["-e", `process.exit(${EXPECTED_FAILURE_EXIT_CODE})`],
          },
        );
        expect(Number(exitCode)).toBe(EXPECTED_FAILURE_EXIT_CODE);

        const retryExitCode = yield* runCommandWithExclusiveFileLock(
          { path: lockPath },
          successfulCommand(),
        );
        expect(Number(retryExitCode)).toBe(ZERO_EXIT_CODE);
      }),
    ),
  );
}

function releasesOnExit() {
  return runTest(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const lockPath = `${directory}/${LOCK_FILE_NAME}`;
        const markerPath = `${directory}/interrupted-holder`;
        const ownerFiber = yield* runCommandWithExclusiveFileLock(
          { path: lockPath },
          markerAndWaitCommand(markerPath),
        ).pipe(Effect.fork);
        yield* waitForFile(fileSystem, markerPath);

        yield* Fiber.interrupt(ownerFiber);
        const exitCode = yield* runCommandWithExclusiveFileLock(
          { path: lockPath },
          successfulCommand(),
        ).pipe(Effect.timeout(Duration.millis(TEST_TIMEOUT_MS)));

        expect(Number(exitCode)).toBe(ZERO_EXIT_CODE);
      }),
    ),
  );
}

function releasesOnCrash() {
  return runTest(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const lockPath = `${directory}/${LOCK_FILE_NAME}`;
        const markerPath = `${directory}/crashed-parent-holder`;
        const lockPlan = yield* buildExclusiveFileLockProcessPlan(
          { path: lockPath },
          markerAndWaitCommand(markerPath),
        );
        const parentPayload = Buffer.from(
          JSON.stringify({ ...lockPlan, markerPath }),
        ).toString("base64url");

        const parentExitCode = yield* Command.exitCode(
          Command.make(execPath, "-e", PARENT_CRASH_SCRIPT, parentPayload),
        ).pipe(Effect.timeout(Duration.millis(TEST_TIMEOUT_MS)));
        expect(Number(parentExitCode)).toBe(ZERO_EXIT_CODE);

        const retryExitCode = yield* runCommandWithExclusiveFileLock(
          { path: lockPath },
          successfulCommand(),
        ).pipe(Effect.timeout(Duration.millis(TEST_TIMEOUT_MS)));
        expect(Number(retryExitCode)).toBe(ZERO_EXIT_CODE);
      }),
    ),
  );
}

function lockEventCommand(
  eventPath: string,
  label: string,
): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return {
    command: execPath,
    args: [
      "-e",
      LOCK_EVENT_SCRIPT,
      eventPath,
      label,
      String(PROTECTED_COMMAND_DURATION_MS),
    ],
  };
}

function markerAndWaitCommand(markerPath: string) {
  return {
    command: execPath,
    args: ["-e", MARK_AND_WAIT_SCRIPT, markerPath],
  };
}

function successfulCommand() {
  return {
    command: execPath,
    args: ["-e", ""],
  };
}

function waitForFile(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void> {
  return fileSystem.exists(path).pipe(
    Effect.orDie,
    Effect.flatMap((exists) =>
      exists
        ? Effect.void
        : Effect.sleep(Duration.millis(FILE_POLL_INTERVAL_MS)).pipe(
            Effect.zipRight(waitForFile(fileSystem, path)),
          ),
    ),
    Effect.timeout(Duration.millis(TEST_TIMEOUT_MS)),
    Effect.orDie,
  );
}

function runTest<A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext>) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(NodeContext.layer), Effect.orDie),
  );
}
