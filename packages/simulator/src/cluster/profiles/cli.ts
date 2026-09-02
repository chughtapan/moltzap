/** @file The `moltzap-sim` executable: one submission through a named profile. */

import { Cause, Effect, Exit, Logger, Option } from "effect";
import type { KubernetesExecutionProfile } from "../profile.js";
import {
  liveSubmitOperations,
  type RunEnvironment,
  RunSubmissionError,
  type SubmitOperations,
} from "../submit.js";
import { runGkeSociety } from "./gke.js";
import { runLocalSociety } from "./local.js";
import { encodeProfileRunResult, type ProfileRunResult } from "./result.js";

/** The one command line the executable accepts. */
export const PROFILE_CLI_USAGE =
  "usage: moltzap-sim run --profile local|gke <spec.mjs>";

/** Signals the executable ends on, named so its last stderr line can say which. */
export type ExecutableSignal = "SIGINT" | "SIGTERM";

/** Every signal the executable turns into an exit status. */
export const EXECUTABLE_SIGNALS: readonly ExecutableSignal[] = Object.freeze([
  "SIGINT",
  "SIGTERM",
]);

// The shell convention: 128 plus the signal number.
const SIGNAL_EXIT_CODES: Readonly<Record<ExecutableSignal, number>> =
  Object.freeze({ SIGINT: 130, SIGTERM: 143 });

/** Repository-owned Kubernetes profile a submission names on its command line. */
export type ProfileName = KubernetesExecutionProfile["kind"];

type ProfileSubmitter = (
  args: readonly string[],
  environment: RunEnvironment,
) => Effect.Effect<ProfileRunResult, RunSubmissionError, SubmitOperations>;

// Total over the profile kinds, so adding a profile without a submitter is a
// compile error rather than a usage error at the first live invocation.
const SUBMITTERS: Readonly<Record<ProfileName, ProfileSubmitter>> = {
  local: runLocalSociety,
  gke: runGkeSociety,
};

/**
 * The executable's whole behaviour against the live cluster boundaries. The
 * words are the command line after the executable name, as
 * `process.argv.slice(2)` gives them.
 *
 * Its stdout carries exactly one result line, so everything else goes to
 * stderr: the submitter's log lines, and a failure as its sanitized typed
 * message or, for anything else, the pretty cause. The process exit code is
 * the runtime's: zero after the line is printed, and non-zero for any
 * failure, including a submission the cluster refused.
 */
export function runProfileExecutable(
  args: readonly string[],
  environment: RunEnvironment,
): Effect.Effect<void, RunSubmissionError> {
  return runProfileCli(args, environment).pipe(
    Effect.tap((submission) =>
      Effect.sync(() => {
        process.stdout.write(`${encodeProfileRunResult(submission)}\n`);
      }),
    ),
    Effect.tapErrorCause((cause) =>
      Effect.sync(() => {
        process.stderr.write(`${failureReport(cause)}\n`);
      }),
    ),
    Effect.provide(liveSubmitOperations),
    Effect.provide(
      Logger.replace(
        Logger.defaultLogger,
        Logger.prettyLogger({ stderr: true }),
      ),
    ),
  );
}

/**
 * Decide the process exit from the main fiber's outcome.
 *
 * The runtime treats an interrupted main fiber as a clean exit, so a
 * submitter killed by SIGTERM would exit zero with no result line, which a
 * consumer that reads the exit code cannot tell from success. Interruption
 * exits with the signal's conventional code instead, after one stderr line
 * naming the signal; stdout stays empty. The reporter writes that line to
 * stderr. A teardown that finds no recorded signal still reports an
 * interruption, and still exits with SIGINT's code.
 */
export function executableTeardown(
  received: () => ExecutableSignal | undefined,
  report: (line: string) => void,
): (exit: Exit.Exit<unknown, unknown>, onExit: (code: number) => void) => void {
  return (exit, onExit) => {
    if (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)) {
      const signal = received();
      report(
        `${signal ?? "interrupted"}: the submission ended before it printed a result line\n`,
      );
      onExit(SIGNAL_EXIT_CODES[signal ?? "SIGINT"]);
      return;
    }
    onExit(Exit.isFailure(exit) ? 1 : 0);
  };
}

/**
 * Submit one RunSpec module through the profile named on the command line.
 *
 * The executable is a thin wrapper: the profile's own submitter reads the
 * environment contract and validates the module path, exactly as it does when
 * the repository's Nx targets invoke it, so a consumer running the packed
 * package and an operator running a checkout reach the same code.
 *
 * The words are the command line after the executable name, so `run` is the
 * first of them.
 *
 * @failure RunSubmissionError at stage `arguments` for any other command line.
 */
export function runProfileCli(
  args: readonly string[],
  environment: RunEnvironment,
): Effect.Effect<ProfileRunResult, RunSubmissionError, SubmitOperations> {
  return Effect.suspend(() => {
    const [command, flag, profile, ...experiment] = args;
    const shaped =
      command === "run" && flag === "--profile" && experiment.length === 1;
    if (!shaped || profile === undefined || !isProfileName(profile)) {
      return Effect.fail(
        new RunSubmissionError({
          stage: "arguments",
          detail: PROFILE_CLI_USAGE,
        }),
      );
    }
    return SUBMITTERS[profile](experiment, environment);
  }).pipe(Effect.withSpan("runProfileCli"));
}

function isProfileName(value: string): value is ProfileName {
  return Object.hasOwn(SUBMITTERS, value);
}

function failureReport(cause: Cause.Cause<RunSubmissionError>): string {
  return Option.match(Cause.failureOption(cause), {
    onNone: () => Cause.pretty(cause),
    onSome: (failure) => failure.message,
  });
}
