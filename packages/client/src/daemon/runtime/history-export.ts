/** @file Append-only export of what one daemon delivered and sent. */

import { FileSystem } from "@effect/platform";
import { DateTime, Effect, Queue, Schema, type Scope } from "effect";
import type { HistoryExportPort } from "../../endpoint/engine-types.js";
import { HistoryExportRecord } from "../../contract.js";

// safer-arch-ignore no-trivial-sink-file: The export writer is one replaceable process edge, kept beside the runtime that installs it rather than inside it so lifecycle composition stays free of file handling.

const encodeLine = Schema.encode(Schema.parseJson(HistoryExportRecord));

/**
 * Open the daemon's history export against one file.
 *
 * Recording only enqueues, so the protocol never waits on the disk: one
 * writer fiber owned by the scope appends the queued records in order, and
 * closing the scope flushes whatever it had not reached. The first append
 * that fails ends the export: one `export-failed` line is written on a
 * best-effort basis, every later record is dropped, and the daemon goes on
 * serving the agent. An experiment must not die because its transcript file
 * did, and the truncation is explicit in the file rather than silent.
 *
 * @param path File the records are appended to; created on first write.
 * @returns A sink the endpoint engine records into.
 */
export function makeHistoryExport(
  path: string,
): Effect.Effect<
  HistoryExportPort,
  never,
  FileSystem.FileSystem | Scope.Scope
> {
  return Effect.gen(function* () {
    const writer = yield* makeWriter(path);
    const pending = yield* Queue.unbounded<HistoryExportRecord>();
    // Registered before the writer fiber, so it runs after that fiber has
    // stopped and appends, in order, whatever the fiber had not taken.
    yield* Effect.addFinalizer(() =>
      Queue.takeAll(pending).pipe(
        Effect.flatMap((records) =>
          Effect.forEach(records, writer.write, {
            concurrency: 1,
            discard: true,
          }),
        ),
      ),
    );
    yield* Effect.forkScoped(
      Effect.forever(Queue.take(pending).pipe(Effect.flatMap(writer.write))),
    );
    return {
      record: (record: HistoryExportRecord) =>
        writer.enabled()
          ? Queue.offer(pending, record).pipe(Effect.asVoid)
          : Effect.void,
    };
  }).pipe(Effect.withSpan("makeHistoryExport"));
}

interface ExportWriter {
  readonly enabled: () => boolean;
  readonly write: (record: HistoryExportRecord) => Effect.Effect<void>;
}

function makeWriter(
  path: string,
): Effect.Effect<ExportWriter, never, FileSystem.FileSystem> {
  return Effect.map(FileSystem.FileSystem, (fileSystem) => {
    let enabled = true;
    const append = (record: HistoryExportRecord) =>
      encodeLine(record).pipe(
        Effect.flatMap((line) =>
          fileSystem.writeFileString(path, `${line}\n`, { flag: "a" }),
        ),
      );
    const disable = (cause: { readonly message: string }) =>
      Effect.gen(function* () {
        enabled = false;
        yield* Effect.logWarning(`history export stopped: ${cause.message}`);
        const at = yield* DateTime.now;
        yield* append({
          kind: "export-failed",
          reason: cause.message,
          at,
        }).pipe(Effect.ignore);
      });
    return {
      enabled: () => enabled,
      // An append in flight finishes before the writer yields to interruption,
      // so a record is never half-written and a flush never overtakes it.
      write: (record) =>
        Effect.uninterruptible(
          Effect.suspend(() =>
            enabled
              ? append(record).pipe(Effect.catchAll(disable))
              : Effect.void,
          ),
        ),
    };
  });
}
