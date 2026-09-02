/** @file The `moltzap-sim` executable: one submission through a named profile. */

import { Cause, Effect, Option } from "effect";
import {
  liveSubmitOperations,
  type RunEnvironment,
  type RunSubmission,
  RunSubmissionError,
  type SubmitOperations,
} from "../submit.js";
import { runGkeSociety } from "./gke.js";
import { runLocalSociety } from "./local.js";
import { encodeProfileRunResult } from "./result.js";

/** The one command line the executable accepts. */
export const PROFILE_CLI_USAGE =
  "usage: moltzap-sim run --profile local|gke <spec.mjs>";

const PROFILE_NAMES = ["local", "gke"] as const;

/** Repository-owned Kubernetes profile a submission names on its command line. */
export type ProfileName = (typeof PROFILE_NAMES)[number];

type ProfileSubmitter = (
  args: readonly string[],
  environment: RunEnvironment,
) => Effect.Effect<RunSubmission, RunSubmissionError, SubmitOperations>;

// Total over the profile names, so adding a profile without a submitter is a
// compile error rather than a usage error at the first live invocation.
const SUBMITTERS: Readonly<Record<ProfileName, ProfileSubmitter>> = {
  local: runLocalSociety,
  gke: runGkeSociety,
};

/**
 * The executable's whole behaviour against the live cluster boundaries.
 *
 * Its stdout carries exactly one result line, so every failure goes to
 * stderr: a typed failure as its sanitized message, anything else as the
 * pretty cause. The process exit code is the runtime's: zero after the line
 * is printed, and non-zero for any failure, including a submission the
 * cluster refused.
 *
 * @param args Command-line words after the executable name.
 * @param environment Process environment the selected profile reads.
 * @returns Completion once the result line is written.
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
  );
}

/**
 * Submit one RunSpec module through the profile named on the command line.
 *
 * The executable is a thin wrapper: the profile's own submitter reads the
 * environment contract and validates the module path, exactly as it does when
 * the repository's Nx targets invoke it, so a consumer running the packed
 * package and an operator running a checkout reach the same code.
 *
 * @param args Command-line words after the executable name.
 * @param environment Process environment the selected profile reads.
 * @returns The coarse run result and ephemeral run identity.
 * @failure RunSubmissionError at stage `arguments` for any other command line.
 */
export function runProfileCli(
  args: readonly string[],
  environment: RunEnvironment,
): Effect.Effect<RunSubmission, RunSubmissionError, SubmitOperations> {
  return Effect.suspend(() => {
    const [command, flag, profile, ...experiment] = args;
    if (
      command !== "run" ||
      flag !== "--profile" ||
      !isProfileName(profile) ||
      experiment.length !== 1
    ) {
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

function isProfileName(value?: string): value is ProfileName {
  return PROFILE_NAMES.some((name) => name === value);
}

function failureReport(cause: Cause.Cause<RunSubmissionError>): string {
  return Option.match(Cause.failureOption(cause), {
    onNone: () => Cause.pretty(cause),
    onSome: (failure) => failure.message,
  });
}
