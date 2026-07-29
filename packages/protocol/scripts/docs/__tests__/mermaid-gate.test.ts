/**
 * @file The gate's job is to fail. These exercise the paths where an input
 * cannot be inspected at all — an unreadable directory, an unreadable file,
 * an unwritable temp slot — because each one used to be swallowed into an
 * empty value and reported as a clean pass.
 */
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Either } from "effect";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectBlocks,
  collectMarkdownFiles,
  lintBlock,
  MermaidGateError,
  requireRoots,
} from "../mermaid-lint.js";

const BLOCK = ["```mermaid", "flowchart TD", "  A --> B", "```", ""].join("\n");

let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "mermaid-gate-"));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const runGate = <A>(
  body: (
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<A, MermaidGateError, never>,
): Promise<Either.Either<A, MermaidGateError>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* body(fs, path);
    }).pipe(Effect.provide(NodeContext.layer), Effect.either),
  );

const failure = <A>(result: Either.Either<A, MermaidGateError>) => {
  if (Either.isRight(result)) {
    throw new Error("expected the gate to fail, but it succeeded");
  }
  return result.left;
};

describe("requireRoots", () => {
  it("accepts a real directory", async () => {
    const dir = join(sandbox, "real-root");
    mkdirSync(dir, { recursive: true });
    const result = await runGate((fs) => requireRoots(fs, [dir]));
    expect(Either.isRight(result)).toBe(true);
  });

  it("fails and names a root that does not exist", async () => {
    const missing = join(sandbox, "absent-root");
    const error = failure(await runGate((fs) => requireRoots(fs, [missing])));
    expect(error._tag).toBe("MermaidGateError");
    expect(error.path).toBe(missing);
    // The underlying error is what tells a reader why the path was
    // unreachable, and it is what the run prints under the header.
    expect(String(error.cause)).toContain(missing);
  });

  it("fails when a root is a file rather than a directory", async () => {
    const file = join(sandbox, "root-is-a-file.md");
    writeFileSync(file, BLOCK);
    const error = failure(await runGate((fs) => requireRoots(fs, [file])));
    expect(error.reason).toContain("not a directory");
    expect(error.path).toBe(file);
  });
});

describe("collectMarkdownFiles", () => {
  it("descends subdirectories and skips node_modules", async () => {
    const root = join(sandbox, "tree");
    mkdirSync(join(root, "nested"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "top.md"), BLOCK);
    writeFileSync(join(root, "nested", "deep.mdx"), BLOCK);
    writeFileSync(join(root, "node_modules", "vendor.md"), BLOCK);

    const result = await runGate((fs, path) =>
      collectMarkdownFiles(fs, path, [root]),
    );
    if (Either.isLeft(result)) throw result.left;
    expect(result.right).toEqual([
      join(root, "nested", "deep.mdx"),
      join(root, "top.md"),
    ]);
  });

  it("fails instead of yielding no files when a directory cannot be listed", async () => {
    const absent = join(sandbox, "absent-tree");
    const error = failure(
      await runGate((fs, path) => collectMarkdownFiles(fs, path, [absent])),
    );
    expect(error.reason).toContain("cannot read directory");
    expect(error.path).toBe(absent);
  });

  // Reaches the per-entry `stat`, which the unreadable-directory cases never
  // do: they fail listing the directory, having stat'ed it successfully.
  it("fails on an entry that cannot be stat'ed", async () => {
    const root = join(sandbox, "dangling-tree");
    mkdirSync(root, { recursive: true });
    const dangling = join(root, "dangling.md");
    symlinkSync(join(sandbox, "no-such-target"), dangling);
    const error = failure(
      await runGate((fs, path) => collectMarkdownFiles(fs, path, [root])),
    );
    expect(error.reason).toBe("cannot stat");
    expect(error.path).toBe(dangling);
  });

  // The finding this guards is an *existing* but unreadable subtree, which
  // only permissions can produce. Root ignores the mode bits, so the check
  // cannot be expressed there.
  const unreadable = process.getuid?.() === 0 ? it.skip : it;
  unreadable(
    "fails on a subtree that exists but cannot be opened",
    async () => {
      const root = join(sandbox, "locked-tree");
      const locked = join(root, "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, "hidden.md"), BLOCK);
      chmodSync(locked, 0o000);
      try {
        const error = failure(
          await runGate((fs, path) => collectMarkdownFiles(fs, path, [root])),
        );
        expect(error.path).toBe(locked);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe("collectBlocks", () => {
  it("extracts blocks labelled relative to the workspace root", async () => {
    const root = join(sandbox, "blocks");
    mkdirSync(root, { recursive: true });
    const file = join(root, "doc.md");
    writeFileSync(file, BLOCK);

    const result = await runGate((fs, path) =>
      collectBlocks(fs, path, root, [file]),
    );
    if (Either.isLeft(result)) throw result.left;
    expect(result.right).toHaveLength(1);
    expect(result.right[0]?.file).toBe("doc.md");
  });

  it("fails instead of yielding no blocks when a file cannot be read", async () => {
    const absent = join(sandbox, "absent-doc.md");
    const error = failure(
      await runGate((fs, path) => collectBlocks(fs, path, sandbox, [absent])),
    );
    expect(error.reason).toContain("cannot read file");
    expect(error.path).toBe(absent);
  });
});

describe("lintBlock", () => {
  const BLOCK_UNDER_TEST = {
    file: "doc.md",
    startLine: 1,
    body: "flowchart TD\n  A --> B",
  };

  // Mirrors the temp name lintBlock derives from the block. If that rule
  // changes, the staged obstacle stops obstructing and the write succeeds,
  // so the test fails rather than quietly stopping testing anything.
  const stagedInputName = "doc_md-1.mmd";

  // Staging fails before mmdc is spawned, so neither case needs a browser.
  const stage = (tempDir: string) =>
    Effect.runPromise(
      lintBlock(BLOCK_UNDER_TEST, tempDir).pipe(
        Effect.provide(NodeContext.layer),
        Effect.either,
      ),
    );

  it("fails when the temp directory cannot be created", async () => {
    const tempDir = join(sandbox, "temp-is-a-file");
    writeFileSync(tempDir, "not a directory");
    const error = failure(await stage(tempDir));
    expect(error.reason).toBe("cannot create temp directory");
    expect(error.path).toBe(tempDir);
  });

  // Separate from the case above: there the directory step fails first, so
  // it would stay green with the write left swallowed.
  it("fails when the input itself cannot be written", async () => {
    const tempDir = join(sandbox, "temp-write-blocked");
    mkdirSync(join(tempDir, stagedInputName), { recursive: true });
    const error = failure(await stage(tempDir));
    expect(error.reason).toBe("cannot write temp input");
    expect(error.path).toBe(join(tempDir, stagedInputName));
  });
});
