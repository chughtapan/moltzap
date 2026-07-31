import { Buffer } from "node:buffer";
import { platform } from "node:os";
import { execPath } from "node:process";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Data, Effect } from "effect";

export interface ExclusiveFileLockOptions {
  readonly path: string;
}

export interface ExclusiveFileLockCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
}

export interface ExclusiveFileLockProcessPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export class ExclusiveFileLockError extends Data.TaggedError(
  "ExclusiveFileLockError",
)<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

const LOCK_SUPERVISOR_SCRIPT = `
const { spawn } = require("node:child_process");
const payload = JSON.parse(
  Buffer.from(process.argv[1], "base64url").toString("utf8"),
);
let child;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch { // #ignore-sloppy-code[bare-catch]: group-kill ESRCH falls back to direct kill — the fallback is the handling
      child.kill("SIGKILL");
    }
  }
  process.exit(1);
};
process.stdin.resume();
process.stdin.once("end", stop);
process.stdin.once("close", stop);
process.on("SIGTERM", stop);
child = spawn(payload.command, payload.args, {
  cwd: payload.cwd,
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.once("exit", (code) => {
  process.exit(code ?? 1);
});
`;
const DARWIN_PLATFORM = "darwin";
const LINUX_PLATFORM = "linux";
const DARWIN_LOCK_COMMAND = "/usr/bin/lockf";
const DARWIN_KEEP_LOCK_FILE_FLAG = "-k";
const LINUX_LOCK_COMMAND = "flock";
const LINUX_EXCLUSIVE_FLAG = "-x";

/**
 * Builds the native lock-holder plan separately so crash tests can place it
 * behind a disposable parent process without changing production behavior.
 * @internal
 */
export function buildExclusiveFileLockProcessPlan(
  options: ExclusiveFileLockOptions,
  protectedCommand: ExclusiveFileLockCommand,
): Effect.Effect<ExclusiveFileLockProcessPlan, ExclusiveFileLockError> {
  const payload = Buffer.from(JSON.stringify(protectedCommand)).toString(
    "base64url",
  );
  const supervisorArgs = ["-e", LOCK_SUPERVISOR_SCRIPT, payload];
  switch (platform()) {
    case DARWIN_PLATFORM:
      return Effect.succeed({
        command: DARWIN_LOCK_COMMAND,
        args: [
          DARWIN_KEEP_LOCK_FILE_FLAG,
          options.path,
          execPath,
          ...supervisorArgs,
        ],
      });
    case LINUX_PLATFORM:
      return Effect.succeed({
        command: LINUX_LOCK_COMMAND,
        args: [LINUX_EXCLUSIVE_FLAG, options.path, execPath, ...supervisorArgs],
      });
    default:
      return Effect.fail(
        toLockError(
          `cross-process file locking is unsupported on ${platform()}`,
        ),
      );
  }
}

/**
 * Runs `protectedCommand` inside the platform kernel's advisory file-lock
 * holder. The supervisor watches its parent's stdin, so parent death stops the
 * protected process tree and releases the kernel lock. Keeping the lock path
 * preserves one inode for every contender without stale-file takeover races.
 */
export function runCommandWithExclusiveFileLock(
  options: ExclusiveFileLockOptions,
  protectedCommand: ExclusiveFileLockCommand,
) {
  return buildExclusiveFileLockProcessPlan(options, protectedCommand).pipe(
    Effect.flatMap((plan) =>
      Command.make(plan.command, ...plan.args).pipe(
        Command.stdout("inherit"),
        Command.stderr("inherit"),
        Command.exitCode,
      ),
    ),
    Effect.mapError((cause) =>
      cause instanceof ExclusiveFileLockError
        ? cause
        : toLockError(`run command under lock ${options.path}`, cause),
    ),
    Effect.provide(NodeContext.layer),
    Effect.withSpan("runCommandWithExclusiveFileLock"),
  );
}

function toLockError(reason: string, cause?: unknown) {
  return new ExclusiveFileLockError({
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}
