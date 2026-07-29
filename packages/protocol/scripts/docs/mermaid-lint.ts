/**
 * @file Validate every fenced ```mermaid block under the docs +
 * packages trees by piping each block through `mmdc` (the official
 * Mermaid CLI). Returns the list of failures grouped by file.
 */
import { Command, FileSystem, Path } from "@effect/platform";
import { Effect, Either } from "effect";

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
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* fs
      .makeDirectory(tempDir, { recursive: true })
      .pipe(Effect.catchAll(() => Effect.void));
    yield* fs
      .writeFileString(inputPath, body)
      .pipe(Effect.catchAll(() => Effect.void));
  });

const runMmdc = (
  inputPath: string,
  outputPath: string,
): Effect.Effect<
  Either.Either<number, unknown>,
  never,
  Command.CommandExecutor
> =>
  Command.make(
    MMDC_BIN,
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--quiet",
  ).pipe(Command.exitCode, Effect.either);

const cleanup = (
  fs: FileSystem.FileSystem,
  inputPath: string,
  outputPath: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* fs.remove(inputPath).pipe(Effect.catchAll(() => Effect.void));
    yield* fs.remove(outputPath).pipe(Effect.catchAll(() => Effect.void));
  });

function interpretResult(
  block: MermaidBlock,
  result: Either.Either<number, unknown>,
): MermaidFailure | null {
  return Either.match(result, {
    onLeft: (e) => ({ block, message: `mmdc launch failed: ${String(e)}` }),
    onRight: (code) =>
      code === 0 ? null : { block, message: `mmdc exited ${String(code)}` },
  });
}
