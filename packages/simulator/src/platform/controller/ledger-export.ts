/** @file Completion-gated export of controller-local ledger artifacts. */

import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Data, Effect } from "effect";
import type { CompletedLedgerReceipt } from "../../kernel/run.js";

const artifactNames = [
  "manifest.json",
  "records.ndjson",
  "completion.json",
] as const;

type ArtifactName = (typeof artifactNames)[number];

/** Active POSIX ledger and retained export root for one completed receipt. */
export interface ControllerLedgerExportInput {
  readonly ledgerDirectory: string;
  readonly exportDirectory: string;
  readonly receipt: CompletedLedgerReceipt;
}

/** Replaceable byte operations used by deterministic export tests. */
export interface ControllerLedgerExportOperations<Requirements = never> {
  readonly makeDirectory: (
    path: string,
  ) => Effect.Effect<void, unknown, Requirements>;
  readonly readFile: (
    path: string,
  ) => Effect.Effect<Uint8Array, unknown, Requirements>;
  readonly writeFile: (
    path: string,
    content: Uint8Array,
  ) => Effect.Effect<void, unknown, Requirements>;
}

/** Sanitized failure while retaining one completed ledger outside the Pod. */
export class ControllerLedgerExportFailed extends Data.TaggedError(
  "ControllerLedgerExportFailed",
)<{
  readonly operation: "directory" | "read" | "write";
  readonly artifact?: ArtifactName;
}> {
  override get message(): string {
    return this.artifact === undefined
      ? "Simulator controller could not prepare retained ledger storage"
      : `Simulator controller could not ${this.operation} ${this.artifact}`;
  }
}

function exportFailure(
  operation: ControllerLedgerExportFailed["operation"],
  artifact?: ArtifactName,
): ControllerLedgerExportFailed {
  return new ControllerLedgerExportFailed({ operation, artifact });
}

/**
 * Copy one completed ledger to retained storage, publishing completion last.
 * @param input Active and retained roots plus the completed receipt.
 * @param operations Byte operations supplied by the controller boundary.
 * @returns Completion after all three retained objects have closed.
 */
export function exportCompletedLedgerWith<Requirements>(
  input: ControllerLedgerExportInput,
  operations: ControllerLedgerExportOperations<Requirements>,
): Effect.Effect<void, ControllerLedgerExportFailed, Requirements> {
  const source = join(input.ledgerDirectory, input.receipt.ledger);
  const destination = join(input.exportDirectory, input.receipt.ledger);
  return Effect.gen(function* () {
    yield* operations
      .makeDirectory(destination)
      .pipe(Effect.mapError(() => exportFailure("directory")));
    for (const artifact of artifactNames) {
      const content = yield* operations
        .readFile(join(source, artifact))
        .pipe(Effect.mapError(() => exportFailure("read", artifact)));
      yield* operations
        .writeFile(join(destination, artifact), content)
        .pipe(Effect.mapError(() => exportFailure("write", artifact)));
    }
  }).pipe(Effect.withSpan("controller.exportCompletedLedger"));
}

/**
 * Export one completed ledger through the Effect platform filesystem.
 * @param input Active and retained roots plus the completed receipt.
 * @returns Completion after the retained completion marker has closed.
 */
export function exportCompletedLedger(input: ControllerLedgerExportInput) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      exportCompletedLedgerWith(input, {
        makeDirectory: (path) =>
          fileSystem.makeDirectory(path, { recursive: true }),
        readFile: (path) => fileSystem.readFile(path),
        writeFile: (path, content) => fileSystem.writeFile(path, content),
      }),
    ),
  );
}
