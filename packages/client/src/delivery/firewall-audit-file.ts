/** @file Private regular files publish audit snapshots only after complete writes. */

import { Data, Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Effect FileSystem does not expose O_NOFOLLOW or descriptor ownership checks required for private audit publication.
import { constants } from "node:fs";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Numeric no-follow exclusive opens and descriptor checks keep operator evidence out of symlink targets.
import {
  type FileHandle,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

/** The private writer receives only a descriptor acquired by the no-follow edge. */
export type AuditFile = FileHandle;

/** File paths and raw I/O diagnostics never cross the process error boundary. */
export class FirewallAuditError extends Data.TaggedError("FirewallAuditError")<{
  readonly reason: "path" | "persistence" | "records";
}> {}

/**
 * The endpoint's exclusive store is acquired before its dedicated audit path.
 * Its private staging entry can therefore belong only to a previous lifetime.
 */
export function privateAuditPath(path: string) {
  return Effect.gen(function* () {
    if (!isAbsolute(path)) {
      return yield* new FirewallAuditError({ reason: "path" });
    }
    const parent = dirname(path);
    const directory = yield* auditIo(() => lstat(parent));
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0
    ) {
      return yield* new FirewallAuditError({ reason: "path" });
    }
    const resolved = join(
      yield* auditIo(() => realpath(parent)),
      basename(path),
    );
    yield* requireRegularDestination(resolved);
    yield* reclaimStagingFile(`${resolved}.partial`);
    return resolved;
  }).pipe(Effect.withSpan("privateAuditPath"));
}

/**
 * The descriptor closes before atomic publication. Cleanup belongs only to the
 * successful exclusive opener, so a competing writer cannot remove its staging
 * file. Publication ends that ownership before another writer can acquire it.
 */
export function writeAuditFile(
  path: string,
  write: (file: AuditFile) => Effect.Effect<void, FirewallAuditError>,
) {
  return Effect.gen(function* () {
    const temporary = `${path}.partial`;
    let owned = false;
    const markOwned = () => {
      owned = true;
    };
    const publish = auditIo(() => rename(temporary, path)).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          owned = false;
        }),
      ),
      Effect.uninterruptible,
    );
    yield* Effect.scoped(writeTemporaryFile(temporary, write, markOwned)).pipe(
      Effect.zipRight(requireRegularDestination(path)),
      Effect.zipRight(publish),
      Effect.ensuring(
        Effect.suspend(() =>
          owned
            ? auditIo(() => unlink(temporary)).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    );
  }).pipe(Effect.withSpan("writeAuditFile"));
}

/** Descriptor writes preserve the same closed error channel as publication. */
export function appendAuditText(file: AuditFile, text: string) {
  return auditIo(() => file.writeFile(text));
}

/** Only absence is acceptable when inspecting an as-yet unwritten destination. */
function requireRegularDestination(path: string) {
  return Effect.gen(function* () {
    const status = yield* auditFileStatus(path);
    if (status !== undefined && (!status.isFile() || status.nlink !== 1)) {
      return yield* new FirewallAuditError({ reason: "path" });
    }
  });
}

function reclaimStagingFile(path: string) {
  return Effect.gen(function* () {
    const status = yield* auditFileStatus(path);
    if (status === undefined) {
      return;
    }
    if (
      !status.isFile() ||
      status.uid !== process.getuid?.() ||
      status.nlink !== 1 ||
      (status.mode & 0o7777) !== 0o600
    ) {
      return yield* new FirewallAuditError({ reason: "path" });
    }
    yield* auditIo(() => unlink(path));
  });
}

function auditFileStatus(path: string) {
  return Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      isAbsent(cause)
        ? Effect.succeed(undefined)
        : Effect.fail(new FirewallAuditError({ reason: "persistence" })),
    ),
  );
}

function isAbsent(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return false;
  }
  return cause.code === "ENOENT";
}

function writeTemporaryFile(
  temporary: string,
  write: (file: AuditFile) => Effect.Effect<void, FirewallAuditError>,
  markOwned: () => void,
) {
  return Effect.gen(function* () {
    const file = yield* openTemporaryFile(temporary, markOwned);
    const status = yield* auditIo(() => file.stat());
    if (
      !status.isFile() ||
      status.uid !== process.getuid?.() ||
      status.nlink !== 1 ||
      (status.mode & 0o7777) !== 0o600
    ) {
      return yield* new FirewallAuditError({ reason: "path" });
    }
    yield* write(file);
    yield* auditIo(() => file.sync());
  });
}

function openTemporaryFile(path: string, markOwned: () => void) {
  return Effect.acquireRelease(
    auditIo(() =>
      open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      ),
    ).pipe(Effect.tap(() => Effect.sync(markOwned))),
    (file) => auditIo(() => file.close()).pipe(Effect.orDie),
  );
}

/** Converts Node's unsupported no-follow descriptor operations to typed Effects. */
// eslint-disable-next-line agent-code-guard/promise-type -- This adapter immediately captures Node filesystem promises; callers receive only Effects.
function auditIo<Value>(operation: () => Promise<Value>) {
  return Effect.tryPromise({
    try: operation,
    catch: () => new FirewallAuditError({ reason: "persistence" }),
  });
}
