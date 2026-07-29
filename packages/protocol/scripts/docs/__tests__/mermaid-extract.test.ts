import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMermaidBlocks, MERMAID_ROOTS } from "../mermaid-lint.js";

const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

describe("MERMAID_ROOTS", () => {
  // A root naming a tree that does not exist contributes no blocks. The
  // gate's own `requireRoots` turns that into a hard failure at runtime;
  // this pins the same invariant at the list, where the typo would land.
  it.each(MERMAID_ROOTS)("resolves %s to a real directory", (root) => {
    expect(statSync(resolve(WORKSPACE_ROOT, root)).isDirectory()).toBe(true);
  });

  it("covers the v2 track", () => {
    expect(MERMAID_ROOTS).toContain("v2");
  });
});

describe("extractMermaidBlocks", () => {
  it("returns empty list when the source has no fenced blocks", () => {
    expect(extractMermaidBlocks("doc.md", "Plain prose.\n")).toEqual([]);
  });

  it("finds a single triple-backtick mermaid block", () => {
    const source = [
      "# Heading",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: hi",
      "```",
      "",
    ].join("\n");
    expect(extractMermaidBlocks("doc.md", source)).toEqual([
      {
        file: "doc.md",
        startLine: 3,
        body: "sequenceDiagram\n  A->>B: hi",
      },
    ]);
  });

  it("finds a triple-tilde mermaid block", () => {
    const source = ["~~~mermaid", "flowchart TD", "  X --> Y", "~~~", ""].join(
      "\n",
    );
    expect(extractMermaidBlocks("doc.md", source)).toEqual([
      {
        file: "doc.md",
        startLine: 1,
        body: "flowchart TD\n  X --> Y",
      },
    ]);
  });

  it("ignores fences indented by 4+ spaces", () => {
    const source = [
      "Snippet inline:",
      "",
      "    ```mermaid",
      "    flowchart TD",
      "    ```",
      "",
    ].join("\n");
    expect(extractMermaidBlocks("doc.md", source)).toEqual([]);
  });

  it("ignores blocks of other languages", () => {
    const source = [
      "```ts",
      "const mermaid = 'something';",
      "```",
      "",
      "```mermaid",
      "sequenceDiagram",
      "```",
      "",
    ].join("\n");
    const blocks = extractMermaidBlocks("doc.md", source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startLine).toBe(5);
  });

  it("collects multiple mermaid blocks with correct line numbers", () => {
    const source = [
      "```mermaid",
      "A",
      "```",
      "",
      "```mermaid",
      "B",
      "```",
      "",
    ].join("\n");
    const blocks = extractMermaidBlocks("doc.md", source);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.startLine).toBe(1);
    expect(blocks[1]?.startLine).toBe(5);
  });
});
