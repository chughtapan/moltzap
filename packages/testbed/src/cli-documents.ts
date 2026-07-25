/**
 * @file Document boundary of the CLI: turning file paths into decoded
 * specs. Spec and bundle documents are YAML, of which JSON is a subset,
 * so one parser reads both encodings.
 *
 * Every failure here is a config-time rejection, deliberately: a missing
 * file, an unparseable document, and a spec that violates its schema are
 * the same event from the caller's seat — nothing ran, and the fix is in
 * the document. Collapsing them into `RunSpecInvalid` keeps the error
 * taxonomy closed rather than growing a parallel filesystem-error family
 * the exit-code mapping would then have to grow with it.
 */
import { basename, extname, join, resolve } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import { RunSpecInvalid } from "./simulator/errors.js";
import { JsonValue, RunSpec } from "./simulator/run-spec.js";

const DOCUMENT_EXTENSIONS = [".yaml", ".yml", ".json"] as const;

type Fs = FileSystem.FileSystem;

const withFs = <A, E>(
  body: (fs: Fs) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.flatMap(FileSystem.FileSystem, body).pipe(
    Effect.provide(NodeContext.layer),
  );

function documentRejected(path: string, detail: string): RunSpecInvalid {
  return new RunSpecInvalid({
    issues: [{ path: [path], message: detail }],
    message: `${path}: ${detail}`,
  });
}

/** Read and parse one YAML or JSON document into the JSON value space. */
export function loadDocument(
  path: string,
): Effect.Effect<JsonValue, RunSpecInvalid, never> {
  return withFs((fs) =>
    fs.readFileString(path).pipe(
      Effect.mapError((cause) =>
        documentRejected(
          path,
          `the document could not be read (${String(cause)}). Check the path.`,
        ),
      ),
      Effect.flatMap((text) => parseDocument(path, text)),
    ),
  ).pipe(Effect.withSpan("loadDocument"));
}

function parseDocument(
  path: string,
  text: string,
): Effect.Effect<JsonValue, RunSpecInvalid, never> {
  return Effect.try({
    try: (): unknown => parseYaml(text),
    catch: (cause) =>
      documentRejected(
        path,
        `the document is not valid YAML or JSON (${String(cause)}).`,
      ),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknown(JsonValue)(parsed).pipe(
        Effect.mapError((cause) =>
          documentRejected(
            path,
            `the document holds values outside the JSON value space (${cause.message}). Dates, undefined, and non-finite numbers are not expressible.`,
          ),
        ),
      ),
    ),
  );
}

/** Read one document and decode it as a RunSpec. */
export function loadSpec(
  path: string,
): Effect.Effect<RunSpec, RunSpecInvalid, never> {
  return loadDocument(path).pipe(
    Effect.flatMap((document) =>
      Schema.decodeUnknown(RunSpec)(document).pipe(
        Effect.mapError((cause) =>
          documentRejected(
            path,
            `the document does not decode as a RunSpec (${cause.message}).`,
          ),
        ),
      ),
    ),
    Effect.withSpan("loadSpec"),
  );
}

/**
 * Expand the `run` verb's inputs: one spec path, several spec paths, or a
 * directory of them. Directory listing is shallow and sorted, so a suite
 * runs in an order the caller can predict from `ls`.
 */
export function collectSpecPaths(
  inputs: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, RunSpecInvalid, never> {
  return Effect.forEach(inputs, expandInput, { concurrency: 1 }).pipe(
    Effect.map((groups) => groups.flat()),
    Effect.flatMap((paths) =>
      paths.length === 0
        ? Effect.fail(
            documentRejected(
              inputs.join(", "),
              `no spec documents found. Name a spec file, several of them, or a directory holding ${DOCUMENT_EXTENSIONS.join(", ")} documents.`,
            ),
          )
        : Effect.succeed(paths),
    ),
    Effect.withSpan("collectSpecPaths"),
  );
}

function expandInput(
  input: string,
): Effect.Effect<ReadonlyArray<string>, RunSpecInvalid, never> {
  const path = resolve(input);
  return withFs((fs) =>
    fs.stat(path).pipe(
      Effect.mapError((cause) =>
        documentRejected(
          input,
          `the path could not be read (${String(cause)}).`,
        ),
      ),
      Effect.flatMap((entry) =>
        entry.type === "Directory"
          ? listDocuments(fs, path)
          : Effect.succeed<ReadonlyArray<string>>([path]),
      ),
    ),
  );
}

function listDocuments(
  fs: Fs,
  directory: string,
): Effect.Effect<ReadonlyArray<string>, RunSpecInvalid, never> {
  return fs.readDirectory(directory).pipe(
    Effect.mapError((cause) =>
      documentRejected(
        directory,
        `the directory could not be listed (${String(cause)}).`,
      ),
    ),
    Effect.map((entries) =>
      entries
        .filter((entry) =>
          DOCUMENT_EXTENSIONS.some((extension) => entry.endsWith(extension)),
        )
        .sort((left, right) => left.localeCompare(right))
        .map((entry) => join(directory, entry)),
    ),
  );
}

/** A bundle's default `scenarioId` is its file stem. */
export function documentStem(path: string): string {
  const name = basename(path, extname(path));
  return name.endsWith(".bundle") ? name.slice(0, -".bundle".length) : name;
}
