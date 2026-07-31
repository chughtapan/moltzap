/**
 * @file Entry point for `pnpm docs:check:mermaid`. Walks docs/ +
 * packages/ for fenced ```mermaid blocks, pipes each through `mmdc`,
 * exits non-zero if any block fails to parse.
 */
import { FileSystem, Path } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractMermaidBlocks,
  lintBlock,
  type MermaidBlock,
  type MermaidFailure,
} from "./docs/mermaid-lint.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const TEMP_DIR = resolve(
  WORKSPACE_ROOT,
  "node_modules",
  ".cache",
  "mermaid-lint",
);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = [
    resolve(WORKSPACE_ROOT, "docs"),
    resolve(WORKSPACE_ROOT, "packages"),
  ];
  const files = yield* collectMarkdownFiles(fs, path, roots);
  const blocks = yield* collectBlocks(fs, path, files);
  yield* announce(blocks.length, files.length);
  const failures = yield* lintAll(blocks);
  yield* report(failures);
});

function announce(
  blocks: number,
  files: number,
): Effect.Effect<void, never, never> {
  return Effect.sync(() =>
    process.stdout.write(
      `Checking ${blocks} Mermaid block(s) across ${files} file(s)...\n`,
    ),
  );
}

function collectBlocks(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  files: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<MermaidBlock>, never, never> {
  return Effect.gen(function* () {
    const out: MermaidBlock[] = [];
    for (const file of files) {
      const source = yield* fs
        .readFileString(file)
        .pipe(Effect.catchAll(() => Effect.succeed("")));
      const workspaceRelative = path.relative(WORKSPACE_ROOT, file);
      out.push(...extractMermaidBlocks(workspaceRelative, source));
    }
    return out;
  });
}

function lintAll(
  blocks: ReadonlyArray<MermaidBlock>,
): Effect.Effect<
  ReadonlyArray<MermaidFailure>,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | import("@effect/platform").Command.CommandExecutor
> {
  return Effect.gen(function* () {
    const results = yield* Effect.forEach(
      blocks,
      (block) => lintBlock(block, TEMP_DIR),
      { concurrency: 4 },
    );
    return results.filter((r): r is MermaidFailure => r !== null);
  });
}

function report(
  failures: ReadonlyArray<MermaidFailure>,
): Effect.Effect<void, never, never> {
  return Effect.sync(() => {
    if (failures.length === 0) {
      process.stdout.write("Mermaid lint: PASS\n");
      return;
    }
    for (const f of failures) {
      process.stderr.write(
        `${f.block.file}:${f.block.startLine} — ${f.message}\n`,
      );
    }
    process.stderr.write(`Mermaid lint: FAIL (${failures.length})\n`);
    process.exit(1);
  });
}

function collectMarkdownFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  roots: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, never, never> {
  return Effect.gen(function* () {
    const ctx: WalkCtx = { fs, path, out: [] };
    for (const root of roots) {
      yield* walkInto(ctx, root);
    }
    return ctx.out.sort();
  });
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

interface WalkCtx {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly out: string[];
}

function walkInto(
  ctx: WalkCtx,
  dir: string,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const entries = yield* ctx.fs
      .readDirectory(dir)
      .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>)));
    for (const name of entries) {
      yield* visitEntry(ctx, dir, name);
    }
  });
}

function visitEntry(
  ctx: WalkCtx,
  dir: string,
  name: string,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    if (SKIP_DIRS.has(name)) return;
    const full = ctx.path.resolve(dir, name);
    const stat = yield* ctx.fs
      .stat(full)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (stat === null) return;
    if (stat.type === "Directory") {
      yield* walkInto(ctx, full);
      return;
    }
    if (name.endsWith(".md") || name.endsWith(".mdx")) ctx.out.push(full);
  });
}

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)));
