/** @file Completion-gated export of controller-local ledger artifacts. */

import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Context, Data, Effect, Layer } from "effect";
import type { CompletedLedgerReceipt } from "../../run/execute.js";

const artifactNames = [
  "manifest.json",
  "records.ndjson",
  "completion.json",
] as const;

type ArtifactName = (typeof artifactNames)[number];

/** Active POSIX ledger and retained export root for one completed receipt. */
export interface ControllerLedgerExportOptions {
  readonly ledgerDirectory: string;
  readonly exportDirectory: string;
  readonly receipt: CompletedLedgerReceipt;
}

/** Byte operations the export uses, replaceable by deterministic tests. */
export interface LedgerExportOperationsService {
  readonly makeDirectory: (path: string) => Effect.Effect<void, unknown>;
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, unknown>;
  readonly writeFile: (
    path: string,
    content: Uint8Array,
  ) => Effect.Effect<void, unknown>;
}

/** Byte operations the controller export reads from its environment. */
export class LedgerExportOperations extends Context.Tag(
  "@moltzap/simulator/LedgerExportOperations",
)<LedgerExportOperations, LedgerExportOperationsService>() {}

/** Sanitized failure while retaining one completed ledger outside the Pod. */
export class ControllerLedgerExportError extends Data.TaggedError(
  "ControllerLedgerExportError",
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
  operation: ControllerLedgerExportError["operation"],
  artifact?: ArtifactName,
): ControllerLedgerExportError {
  return new ControllerLedgerExportError({ operation, artifact });
}

/**
 * Copy one completed ledger to retained storage, publishing completion last.
 * @param options Active and retained roots plus the completed receipt.
 * @returns Completion after all three retained objects have closed.
 */
export function exportCompletedLedger(
  options: ControllerLedgerExportOptions,
): Effect.Effect<void, ControllerLedgerExportError, LedgerExportOperations> {
  const source = join(options.ledgerDirectory, options.receipt.ledger);
  const destination = join(options.exportDirectory, options.receipt.ledger);
  return Effect.gen(function* () {
    const operations = yield* LedgerExportOperations;
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

/** Retained-ledger bytes written through the Effect platform filesystem. */
export const filesystemLedgerExportOperations: Layer.Layer<
  LedgerExportOperations,
  never,
  FileSystem.FileSystem
> = Layer.effect(
  LedgerExportOperations,
  Effect.map(FileSystem.FileSystem, (fileSystem) => ({
    makeDirectory: (path: string) =>
      fileSystem.makeDirectory(path, { recursive: true }),
    readFile: (path: string) => fileSystem.readFile(path),
    writeFile: (path: string, content: Uint8Array) =>
      fileSystem.writeFile(path, content),
  })),
);
