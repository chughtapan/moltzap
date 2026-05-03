import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Cause, Data, Effect } from "effect";
import type { ReplayBundle, TranscriptMeta } from "./types.js";

const SAFE_SEGMENT_RE = /[^a-zA-Z0-9._-]+/gu;
const EMPTY_SEGMENT_FALLBACK = "unknown";
const TRANSCRIPT_JSON_INDENT_SPACES = 2;

export class TranscriptWriterError extends Data.TaggedError(
  "TranscriptWriterError",
)<{
  readonly reason: "MkdirFailed" | "WriteFailed" | "InvalidOutDir";
  readonly path: string;
  readonly message: string;
  readonly cause?: Cause.Cause<unknown>;
}> {}

export interface TranscriptWriter {
  readonly write: (
    bundle: ReplayBundle,
    meta: TranscriptMeta,
    outDir: string,
  ) => Effect.Effect<string, TranscriptWriterError>;
}

export function makeTranscriptWriter(): Effect.Effect<TranscriptWriter, never> {
  return Effect.succeed({
    write: (bundle, meta, outDir) =>
      Effect.gen(function* () {
        if (hasParentTraversal(outDir)) {
          return yield* Effect.fail(
            new TranscriptWriterError({
              reason: "InvalidOutDir",
              path: outDir,
              message: `Transcript output directory must not contain '..': ${outDir}`,
            }),
          );
        }

        const dirName = transcriptDirName(bundle, meta);
        const outputDir = path.join(outDir, dirName);
        const outputPath = path.join(outputDir, "transcript.json");
        yield* fsVoid("MkdirFailed", outputDir, () =>
          fsp.mkdir(outputDir, { recursive: true }),
        );
        yield* fsVoid("WriteFailed", outputPath, () =>
          fsp.writeFile(
            outputPath,
            JSON.stringify(
              transcriptPayload(bundle, meta),
              null,
              TRANSCRIPT_JSON_INDENT_SPACES,
            ) + "\n",
            "utf8",
          ),
        );
        return outputPath;
      }),
  });
}

function transcriptDirName(bundle: ReplayBundle, meta: TranscriptMeta): string {
  const ts = sanitizeSegment(bundle.finishedAt);
  switch (meta.kind) {
    case "arena-live":
      return [
        "arena-live",
        meta.gameNumber.toString(),
        sanitizeSegment(meta.model),
        ts,
      ].join("-");
    case "generic":
      return [sanitizeSegment(bundle.sessionId as string), ts].join("-");
    default:
      return absurd(meta);
  }
}

function transcriptPayload(bundle: ReplayBundle, meta: TranscriptMeta) {
  switch (meta.kind) {
    case "arena-live":
      return {
        meta: {
          model: meta.model,
          playerCount: meta.playerCount,
          gameNumber: meta.gameNumber,
          startedAt: bundle.startedAt,
          finishedAt: bundle.finishedAt,
          winner: snapshotField(bundle.appData, "winner"),
          rounds: snapshotField(bundle.appData, "rounds"),
          status: meta.status,
        },
        gameplay: bundle.appData,
        traceEvents: bundle.traceEvents,
      };
    case "generic":
      return {
        meta: meta.attributes,
        gameplay: bundle.appData,
        traceEvents: bundle.traceEvents,
      };
    default:
      return absurd(meta);
  }
}

function snapshotField(
  snapshot: Readonly<Record<string, unknown>>,
  key: string,
) {
  return snapshot[key];
}

function sanitizeSegment(input: string): string {
  const sanitized = input.replace(SAFE_SEGMENT_RE, "-");
  return sanitized.length === 0 ? EMPTY_SEGMENT_FALLBACK : sanitized;
}

function hasParentTraversal(input: string): boolean {
  return input.split(/[\\/]+/u).includes("..");
}

function fsVoid(
  reason: TranscriptWriterError["reason"],
  filePath: string,
  run: () => PromiseLike<unknown>,
): Effect.Effect<void, TranscriptWriterError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new TranscriptWriterError({
        reason,
        path: filePath,
        message: `${reason} at ${filePath}`,
        cause: Cause.die(cause),
      }),
  }).pipe(Effect.asVoid);
}

function absurd(value: never): never {
  return value;
}
