/** @file Reading one file back from a live application container. */

import type { Exec, V1Status } from "@kubernetes/client-node";
import { Data, Effect } from "effect";
import { PassThrough } from "node:stream";
import type { HarvestedFileOutcome } from "../../events/core.js";
import { APPLICATION_CONTAINER_NAME } from "./objects.js";

/** Exit the harvest probe reserves for a target that is not a regular file. */
const HARVEST_ABSENT_EXIT = 66;
/** Exit the harvest probe reserves for a file larger than its target's bound. */
const HARVEST_OVERSIZE_EXIT = 67;
// The path and the bound are positional arguments, never spliced into the
// script, so a file name is data to the shell rather than syntax. The size is
// reported on stderr ahead of the oversize exit because nothing else in the
// exchange can carry it.
const HARVEST_PROBE = [
  `test -f "$1" || exit ${String(HARVEST_ABSENT_EXIT)}`,
  'size="$(wc -c < "$1" | tr -d " ")" || exit 65',
  `[ "$size" -le "$2" ] || { printf %s "$size" >&2; exit ${String(HARVEST_OVERSIZE_EXIT)}; }`,
  'cat -- "$1"',
].join("\n");
const utf8 = new TextDecoder("utf-8", { fatal: true });

type ExecSocket = Awaited<ReturnType<Exec["exec"]>>;

/** The exec session ended with the cluster refusing or dropping it. */
export class ExecSessionFailed extends Data.TaggedError("ExecSessionFailed")<{
  readonly cause: unknown;
}> {}

/** One file read the probe is asked to make inside one application Pod. */
export interface ApplicationFileRead {
  readonly namespace: string;
  readonly podName: string;
  readonly path: string;
  readonly limitBytes: number;
}

/** Everything one exec of the harvest probe left behind. */
export interface ApplicationFileObservation {
  /** Absent when the exec ended without reporting a status. */
  readonly exitCode?: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

/**
 * The shell command that reads one harvest target inside an application.
 *
 * It is a plain `sh` probe so that every agent image already has what it
 * needs. `test -f` and `cat` both follow symbolic links, and the file is
 * checked and then read as two steps: an application that replaces its own
 * harvested file with a link exposes whatever that link names inside its own
 * container into the ledger. That is accepted: the container holds nothing
 * the experiment did not give it, and the ledger is the experiment's own.
 *
 * @param path Absolute in-container path of the target.
 * @param limitBytes Largest file the probe will print.
 * @returns The exec command, with the path as data rather than syntax.
 */
export function harvestCommand(
  path: string,
  limitBytes: number,
): readonly string[] {
  return ["sh", "-c", HARVEST_PROBE, "harvest", path, String(limitBytes)];
}

/**
 * The exit code an exec status frame reports, if it reports one at all.
 * @param status Final status frame of the exec session.
 * @returns The command's exit code, or undefined when the frame carries none.
 */
export function execExitCode(status: V1Status): number | undefined {
  if (status.status === "Success") {
    return 0;
  }
  if (status.reason !== "NonZeroExitCode") {
    return undefined;
  }
  const code = Number(
    status.details?.causes?.find((cause) => cause.reason === "ExitCode")
      ?.message,
  );
  return Number.isSafeInteger(code) && code >= 0 ? code : undefined;
}

/**
 * Decode what the harvest probe left into the ledger's closed outcome.
 * @param observation Exit code and captured output of one probe run.
 * @param limitBytes Bound the probe was given, restated in an oversize outcome.
 * @returns The typed outcome; never a failure, because every shape has one.
 */
export function applicationFileOutcome(
  observation: ApplicationFileObservation,
  limitBytes: number,
): HarvestedFileOutcome {
  switch (observation.exitCode) {
    case 0:
      return textOutcome(observation.stdout, limitBytes);
    case HARVEST_ABSENT_EXIT:
      return { _tag: "absent" };
    case HARVEST_OVERSIZE_EXIT:
      return {
        _tag: "oversize",
        byteLength: reportedSize(observation.stderr),
        limitBytes,
      };
    case undefined:
      return {
        _tag: "unreadable",
        cause: "the read ended without an exit status",
      };
    default:
      return {
        _tag: "unreadable",
        cause: exitCause(observation.exitCode, observation.stderr),
      };
  }
}

/**
 * Run the harvest probe in one application container and collect what it
 * left. One exec session per read: connect, let the probe run to its status
 * frame, and settle when the socket closes, which is the only event that
 * follows every output frame. Interruption closes the socket, so an
 * abandoned read holds no API connection open.
 * @param exec Exec client bound to the run's cluster credentials.
 * @param read Pod, path, and bound of the one file to read.
 * @returns The probe's exit code and captured output.
 */
export function execHarvestProbe(
  exec: Exec,
  read: ApplicationFileRead,
): Effect.Effect<ApplicationFileObservation, ExecSessionFailed> {
  return Effect.suspend(() => {
    const session = makeSession();
    return Effect.tryPromise({
      try: () =>
        exec.exec(
          read.namespace,
          read.podName,
          APPLICATION_CONTAINER_NAME,
          [...harvestCommand(read.path, read.limitBytes)],
          session.stdout,
          session.stderr,
          null,
          false,
          session.observeStatus,
        ),
      catch: (cause) => new ExecSessionFailed({ cause }),
    }).pipe(
      Effect.flatMap((socket) => awaitSessionEnd(socket, session.observation)),
    );
  });
}

interface ProbeSession {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly observeStatus: (status: V1Status) => void;
  readonly observation: () => ApplicationFileObservation;
}

function makeSession(): ProbeSession {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let status: V1Status | undefined;
  return {
    stdout: collector(stdout),
    stderr: collector(stderr),
    observeStatus: (observed) => {
      status = observed;
    },
    observation: () => ({
      exitCode: status === undefined ? undefined : execExitCode(status),
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }),
  };
}

function awaitSessionEnd(
  socket: ExecSocket,
  observation: () => ApplicationFileObservation,
): Effect.Effect<ApplicationFileObservation, ExecSessionFailed> {
  return Effect.async<ApplicationFileObservation, ExecSessionFailed>(
    (resume) => {
      if (socket.readyState === socket.CLOSED) {
        resume(Effect.succeed(observation()));
        return;
      }
      socket.once("error", (cause: unknown) => {
        resume(Effect.fail(new ExecSessionFailed({ cause })));
      });
      socket.once("close", () => {
        resume(Effect.succeed(observation()));
      });
      return Effect.sync(() => {
        socket.close();
      });
    },
  );
}

function collector(chunks: Buffer[]): PassThrough {
  const stream = new PassThrough();
  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  return stream;
}

function textOutcome(
  stdout: Uint8Array,
  limitBytes: number,
): HarvestedFileOutcome {
  if (stdout.byteLength > limitBytes) {
    return { _tag: "oversize", byteLength: stdout.byteLength, limitBytes };
  }
  try {
    return {
      _tag: "text",
      content: utf8.decode(stdout),
      byteLength: stdout.byteLength,
    };
  } catch (cause) {
    return {
      _tag: "unreadable",
      cause: `the file is not UTF-8 text: ${String(cause)}`,
    };
  }
}

// A size the probe could not report reads as zero: the outcome still says
// the file was larger than what the ledger would carry.
function reportedSize(stderr: string): number {
  const size = Number(stderr.trim());
  return Number.isSafeInteger(size) && size >= 0 ? size : 0;
}

function exitCause(exitCode: number, stderr: string): string {
  const detail = stderr.trim();
  return detail.length === 0
    ? `the read exited ${String(exitCode)}`
    : `the read exited ${String(exitCode)}: ${detail}`;
}
