/**
 * @file Validate every fenced ```mermaid block under the trees named by
 * `MERMAID_ROOTS` by piping each block through `mmdc` (the official
 * Mermaid CLI). Returns the list of failures grouped by file.
 */
import { Command, FileSystem, Path } from "@effect/platform";
import { Effect, Either, Stream } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Workspace-relative trees the gate walks. Every documented tree must be
 * listed here: a tree left out is not reported as skipped, it simply
 * contributes zero blocks and the gate passes without having looked.
 */
export const MERMAID_ROOTS = ["docs", "packages", "v2"] as const;

export interface MermaidBlock {
  readonly file: string;
  readonly startLine: number;
  readonly body: string;
}

export interface MermaidFailure {
  readonly block: MermaidBlock;
  readonly message: string;
}

interface ExtractorState {
  inFence: boolean;
  fenceLang: string | null;
  blockStart: number;
  bodyLines: string[];
  out: MermaidBlock[];
}

/**
 * Locate every fenced ```mermaid block in the given file. Returns the
 * block's 1-based start line (the opening fence) and raw body text.
 * Skips blocks whose fence is preceded by 4+ spaces (markdown
 * indented-code) and blocks fenced in a different language.
 */
export function extractMermaidBlocks(
  file: string,
  source: string,
): ReadonlyArray<MermaidBlock> {
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
  const fenceMatch = line.match(/^([ \t]*)(```+|~~~+)([A-Za-z0-9_-]*)\s*$/);
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
    if (indent.length >= 4) return;
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
 */
export const lintBlock = (
  block: MermaidBlock,
  tempDir: string,
): Effect.Effect<
  MermaidFailure | null,
  never,
  FileSystem.FileSystem | Path.Path | Command.CommandExecutor
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

const prepareInput = (
  fs: FileSystem.FileSystem,
  tempDir: string,
  inputPath: string,
  body: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    yield* fs
      .makeDirectory(tempDir, { recursive: true })
      .pipe(Effect.catchAll(() => Effect.void));
    yield* fs
      .writeFileString(inputPath, body)
      .pipe(Effect.catchAll(() => Effect.void));
  });

/**
 * Run one block through `mmdc`, keeping its stderr. mmdc reports both
 * diagram syntax errors and browser launch failures there, and the exit
 * code alone cannot tell those apart.
 */
const runMmdc = (
  inputPath: string,
  outputPath: string,
): Effect.Effect<
  Either.Either<MmdcRun, unknown>,
  never,
  Command.CommandExecutor
> =>
  Effect.scoped(
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

const cleanup = (
  fs: FileSystem.FileSystem,
  inputPath: string,
  outputPath: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    yield* fs.remove(inputPath).pipe(Effect.catchAll(() => Effect.void));
    yield* fs.remove(outputPath).pipe(Effect.catchAll(() => Effect.void));
  });

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
 */
function formatStderr(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0 && !/^\s*at\s/.test(l))
    .slice(0, STDERR_LINES_KEPT);
  if (lines.length === 0) return "";
  return `\n${lines.map((l) => `    ${l}`).join("\n")}`;
}
