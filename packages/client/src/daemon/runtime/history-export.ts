/** @file Append-only export of what one daemon delivered and sent. */

import { FileSystem } from "@effect/platform";
import { DateTime, Effect, Schema } from "effect";
import type { HistoryExportPort } from "../../endpoint/engine-types.js";
import { HistoryExportRecord } from "../../contract.js";

// safer-arch-ignore no-trivial-sink-file: The export writer is one replaceable process edge, kept beside the runtime that installs it rather than inside it so lifecycle composition stays free of file handling.

const encodeLine = Schema.encode(Schema.parseJson(HistoryExportRecord));

/**
 * Open the daemon's history export against one file.
 *
 * Recording completes only once the line is on disk: an inbound record lands
 * before its message becomes visible to the agent and an outbound record
 * before the send returns, so a transcript harvested the moment a program
 * ends holds every delivery and send that program could have observed. That
 * costs one append inside the delivery path, accepted for an opt-in evidence
 * file whose worth is its completeness. Lines are appended one at a time
 * under a gate, so two records never interleave. The first append that fails
 * ends the export: one `export-failed` line is written on a best-effort
 * basis, every later record is dropped, and the daemon goes on serving the
 * agent. An experiment must not die because its transcript file did, and the
 * truncation is explicit in the file rather than silent.
 *
 * @param path File the records are appended to; created on first write.
 * @returns A sink the endpoint engine records into.
 */
export function makeHistoryExport(
  path: string,
): Effect.Effect<HistoryExportPort, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const gate = yield* Effect.makeSemaphore(1);
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
      record: (record: HistoryExportRecord) =>
        gate.withPermits(1)(
          Effect.suspend(() =>
            enabled
              ? append(record).pipe(Effect.catchAll(disable))
              : Effect.void,
          ),
        ),
    };
  }).pipe(Effect.withSpan("makeHistoryExport"));
}
