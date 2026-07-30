/**
 * @file Collect every fenced ```mermaid block under the trees named by
 * `MERMAID_ROOTS` and validate each by piping it through `mmdc` (the
 * official Mermaid CLI). Returns the list of failures grouped by file.
 */
import {
  Command,
  FileSystem,
  Path,
  type CommandExecutor,
} from "@effect/platform";
import { Data, Effect, Either, Stream } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Workspace-relative trees the gate walks. Every documented tree must be
 * listed here: a tree left out is not reported as skipped, it simply
 * contributes zero blocks and the gate passes without having looked.
 */
export const MERMAID_ROOTS = ["docs", "packages", "v2"] as const;

/**
 * Something the gate was asked to inspect but could not.
 *
 * Every filesystem step here answers "what am I checking?", so a failure
 * means some input went unchecked. Substituting an empty default — no
 * entries, no source text, no temp file — makes that indistinguishable
 * from a clean result, which is precisely the blind-gate failure this
 * gate exists to catch. The path travels with the error because a run
 * that cannot say which input it skipped has not reported anything.
 */
export class MermaidGateError extends Data.TaggedError("MermaidGateError")<{
  readonly reason: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

const gateError =
  (reason: string, path: string) =>
  (cause: unknown): MermaidGateError =>
    new MermaidGateError({ reason, path, cause });

/** Describes mermaid block. */
export interface MermaidBlock {
  readonly file: string;
  readonly startLine: number;
  readonly body: string;
}

/** Describes mermaid failure. */
export interface MermaidFailure {
  readonly block: MermaidBlock;
  readonly message: string;
}

/** Directories that never hold reviewable documentation. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

interface WalkCtx {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly out: string[];
}

/**
 * Reject any configured root that is not a usable directory. A root that
 * is missing, unreadable, or a plain file contributes no files, so without
 * this the run would report a clean pass over a tree it never opened.
 * @param fs Value supplied to the operation.
 * @param roots Value supplied to the operation.
 * @returns The require roots result.
 */
export const requireRoots = (
  fs: FileSystem.FileSystem,
  roots: readonly string[],
): Effect.Effect<void, MermaidGateError> =>
  Effect.forEach(
    roots,
    (root) =>
      fs.stat(root).pipe(
        Effect.mapError(gateError("cannot open configured root", root)),
        Effect.flatMap((info) =>
          info.type === "Directory"
            ? Effect.void
            : Effect.fail(
                new MermaidGateError({
                  reason: "configured root is not a directory",
                  path: root,
                  cause: info.type,
                }),
              ),
        ),
      ),
    // Sequential so the first unusable root is the one reported, in the
    // order the list declares them.
    { discard: true, concurrency: 1 },
  );

/**
 * Every `.md` and `.mdx` file below `roots`, sorted for stable output.
 * @param fs Value supplied to the operation.
 * @param path Path to process.
 * @param roots Value supplied to the operation.
 * @returns The collect markdown files result.
 */
export const collectMarkdownFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  roots: readonly string[],
): Effect.Effect<readonly string[], MermaidGateError> =>
  Effect.gen(function* () {
    const ctx: WalkCtx = { fs, path, out: [] };
    for (const root of roots) {
      yield* walkInto(ctx, root);
    }
    return ctx.out.sort((left, right) => left.localeCompare(right));
  });

function walkInto(
  ctx: WalkCtx,
  dir: string,
): Effect.Effect<void, MermaidGateError> {
  return Effect.gen(function* () {
    const entries = yield* ctx.fs
      .readDirectory(dir)
      .pipe(Effect.mapError(gateError("cannot read directory", dir)));
    for (const name of entries) {
      yield* visitEntry(ctx, dir, name);
    }
  });
}

function visitEntry(
  ctx: WalkCtx,
  dir: string,
  name: string,
): Effect.Effect<void, MermaidGateError> {
  return Effect.gen(function* () {
    if (SKIP_DIRS.has(name)) {
      return;
    }
    const full = ctx.path.resolve(dir, name);
    const info = yield* ctx.fs
      .stat(full)
      .pipe(Effect.mapError(gateError("cannot stat", full)));
    if (info.type === "Directory") {
      yield* walkInto(ctx, full);
      return;
    }
    if (name.endsWith(".md") || name.endsWith(".mdx")) {
      ctx.out.push(full);
    }
  });
}

/**
 * Extract every fenced block from `files`, labelled relative to the root.
 * @param fs Value supplied to the operation.
 * @param path Path to process.
 * @param workspaceRoot Value supplied to the operation.
 * @param files Value supplied to the operation.
 * @returns The extract mermaid blocks result.
 */
export const collectBlocks = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workspaceRoot: string,
  files: readonly string[],
): Effect.Effect<readonly MermaidBlock[], MermaidGateError> =>
  Effect.gen(function* () {
    const out: MermaidBlock[] = [];
    for (const file of files) {
      const source = yield* fs
        .readFileString(file)
        .pipe(Effect.mapError(gateError("cannot read file", file)));
      out.push(
        ...extractMermaidBlocks(path.relative(workspaceRoot, file), source),
      );
    }
    return out;
  });

interface ExtractorState {
  inFence: boolean;
  fenceLang: string | null;
  blockStart: number;
  bodyLines: string[];
  out: MermaidBlock[];
}

/**
 * Locate every fenced `mermaid` block in the given file. Returns the
 * block's 1-based start line (the opening fence) and raw body text.
 * Skips blocks whose fence is preceded by 4+ spaces (markdown
 * indented-code) and blocks fenced in a different language.
 * @param file Source file path.
 * @param source Source text to process.
 * @returns The extract mermaid blocks result.
 */
export function extractMermaidBlocks(
  file: string,
  source: string,
): readonly MermaidBlock[] {
  const lines = source.split("\n");
  const state: ExtractorState = {
    inFence: false,
    fenceLang: null,
    blockStart: -1,
    bodyLines: [],
    out: [],
  };
  for (let i = 0; i < lines.length; i++) {
    processLine(file, lines[i] ?? "", i, state);
  }
  return state.out;
}

function processLine(
  file: string,
  line: string,
  lineIx: number,
  state: ExtractorState,
): void {
  const fenceMatch = /^([ \t]*)(```+|~~~+)([A-Za-z0-9_-]*)\s*$/.exec(line);
  if (fenceMatch) {
    handleFence(file, fenceMatch, lineIx, state);
    return;
  }
  if (state.inFence && state.fenceLang === "mermaid") {
    state.bodyLines.push(line);
  }
}

function handleFence(
  file: string,
  match: RegExpMatchArray,
  lineIx: number,
  state: ExtractorState,
): void {
  const indent = match[1] ?? "";
  const lang = match[3] ?? "";
  if (!state.inFence) {
    if (indent.length >= 4) {
      return;
    }
    state.inFence = true;
    state.fenceLang = lang || null;
    state.blockStart = lineIx + 1;
    state.bodyLines = [];
    return;
  }
  if (state.fenceLang === "mermaid") {
    state.out.push({
      file,
      startLine: state.blockStart,
      body: state.bodyLines.join("\n"),
    });
  }
  state.inFence = false;
  state.fenceLang = null;
}

const MMDC_BIN = "mmdc";

/**
 * Chrome launch flags for the renderer. `mmdc` merges this file into its
 * `puppeteer.launch()` options.
 */
const PUPPETEER_CONFIG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "mermaid-puppeteer.json",
);

/** Lines of mmdc stderr kept in a failure message; the rest is stack noise. */
const STDERR_LINES_KEPT = 6;

interface MmdcRun {
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * Validate `block.body` by writing it to a temp file and shelling out
 * to `mmdc`. Returns null on success or a `MermaidFailure` carrying
 * mmdc's exit context on failure.
 * @param block Mermaid source block to validate.
 * @param tempDir Temporary directory for generated artifacts.
 * @returns The lint block result.
 */
export const lintBlock = (
  block: MermaidBlock,
  tempDir: string,
): Effect.Effect<
  MermaidFailure | null,
  MermaidGateError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const slug = `${block.file.replace(/[^a-zA-Z0-9]/g, "_")}-${block.startLine}`;
    const inputPath = path.resolve(tempDir, `${slug}.mmd`);
    const outputPath = path.resolve(tempDir, `${slug}.svg`);
    yield* prepareInput(fs, tempDir, inputPath, block.body);
    const result = yield* runMmdc(inputPath, outputPath);
    yield* cleanup(fs, inputPath, outputPath);
    return interpretResult(block, result);
  });

/**
 * Stage one block for `mmdc`. The temp path is derived from the block's
 * file and line, so a discarded write error would leave whatever the last
 * run put there and `mmdc` would happily validate that instead — passing
 * the block that was never written.
 * @param fs Value supplied to the operation.
 * @param tempDir Temporary directory for generated artifacts.
 * @param inputPath Value supplied to the operation.
 * @param body Serialized response body to decode.
 * @returns The prepare input result.
 */
function prepareInput(
  fs: FileSystem.FileSystem,
  tempDir: string,
  inputPath: string,
  body: string,
): Effect.Effect<void, MermaidGateError> {
  return Effect.gen(function* () {
    yield* fs
      .makeDirectory(tempDir, { recursive: true })
      .pipe(
        Effect.mapError(gateError("cannot create temp directory", tempDir)),
      );
    yield* fs
      .writeFileString(inputPath, body)
      .pipe(Effect.mapError(gateError("cannot write temp input", inputPath)));
  });
}

/**
 * Run one block through `mmdc`, keeping its stderr. Mmdc reports both
 * diagram syntax errors and browser launch failures there, and the exit
 * code alone cannot tell those apart.
 * @param inputPath Value supplied to the operation.
 * @param outputPath Value supplied to the operation.
 * @returns The run mmdc result.
 */
function runMmdc(
  inputPath: string,
  outputPath: string,
): Effect.Effect<
  Either.Either<MmdcRun, unknown>,
  never,
  CommandExecutor.CommandExecutor
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* Command.make(
        MMDC_BIN,
        "--input",
        inputPath,
        "--output",
        outputPath,
        "--puppeteerConfigFile",
        PUPPETEER_CONFIG,
        "--quiet",
      ).pipe(
        // stdout stays inherited so only stderr needs draining; a piped
        // stdout nobody reads can wedge the child once its buffer fills.
        Command.stdout("inherit"),
        Command.stderr("pipe"),
        Command.start,
      );
      const stderr = yield* proc.stderr.pipe(
        Stream.decodeText(),
        Stream.mkString,
      );
      const exitCode = yield* proc.exitCode;
      return { exitCode, stderr } satisfies MmdcRun;
    }),
  ).pipe(Effect.either);
}

/**
 * Best-effort, unlike the write above: a block that fails to parse leaves
 * no SVG behind, so removing it is expected to fail and says nothing about
 * whether the block was checked. Leftovers cannot mask a bad block either,
 * since every run fails outright if it cannot overwrite its input.
 * @param fs Value supplied to the operation.
 * @param inputPath Value supplied to the operation.
 * @param outputPath Value supplied to the operation.
 * @returns The interpret result result.
 */
function cleanup(
  fs: FileSystem.FileSystem,
  inputPath: string,
  outputPath: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* fs.remove(inputPath).pipe(Effect.catchAll(() => Effect.void));
    yield* fs.remove(outputPath).pipe(Effect.catchAll(() => Effect.void));
  });
}

function interpretResult(
  block: MermaidBlock,
  result: Either.Either<MmdcRun, unknown>,
): MermaidFailure | null {
  return Either.match(result, {
    onLeft: (e) => ({ block, message: `mmdc launch failed: ${String(e)}` }),
    onRight: (run) =>
      run.exitCode === 0
        ? null
        : {
            block,
            message: `mmdc exited ${String(run.exitCode)}${formatStderr(run.stderr)}`,
          },
  });
}

/**
 * Indent the leading lines of mmdc stderr under the failure's header.
 * Stack frames are dropped: a browser launch failure buries its one useful
 * line under a deep trace, and that trace repeats for every block.
 * @param stderr Value supplied to the operation.
 * @returns The format stderr result.
 */
function formatStderr(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0 && !/^\s*at\s/.test(l))
    .slice(0, STDERR_LINES_KEPT);
  if (lines.length === 0) {
    return "";
  }
  return `\n${lines.map((l) => `    ${l}`).join("\n")}`;
}
