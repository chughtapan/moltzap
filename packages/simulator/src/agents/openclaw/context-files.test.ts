import { createRequire } from "node:module";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- the canary reads the installed OpenClaw dist synchronously inside a unit test.
import fs from "node:fs";
import path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { AgentRuntimeDefinitionError } from "../agent.js";
import { OPENCLAW_CONTEXT_FILENAMES, openClawRuntime } from "./runtime.js";

describe("workspace-file reachability guard", () => {
  it("refuses a file the model can provably never see", () => {
    assert.throws(
      () =>
        openClawRuntime({
          workspaceFiles: [{ relativePath: "BRIEF.md", content: "brief" }],
          tools: { deny: ["*"] },
        }),
      AgentRuntimeDefinitionError,
    );
  });

  it("accepts a non-injected file when tools could still read it", () => {
    assert.doesNotThrow(() =>
      openClawRuntime({
        workspaceFiles: [{ relativePath: "BRIEF.md", content: "brief" }],
      }),
    );
  });

  it("accepts injected filenames even with every tool denied", () => {
    assert.doesNotThrow(() =>
      openClawRuntime({
        workspaceFiles: [{ relativePath: "AGENTS.md", content: "brief" }],
        tools: { deny: ["*"] },
      }),
    );
  });
});

function filenameStems(source: string): string[] {
  return [...source.matchAll(/DEFAULT_([A-Z]+)_FILENAME/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("context filename drift canary", () => {
  it("matches the installed OpenClaw's bootstrap loader entries", () => {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve("openclaw/plugin-sdk");
    const distIndex = sdkEntry.indexOf(`${path.sep}dist${path.sep}`);
    assert.isAbove(distIndex, 0, "openclaw's dist directory moved");
    const distDir = sdkEntry.slice(0, distIndex + 5);
    const stems = new Set<string>(
      fs
        .readdirSync(distDir)
        .filter((name) => name.endsWith(".js"))
        .map((name) => fs.readFileSync(path.join(distDir, name), "utf8"))
        .filter((source) => source.includes("loadWorkspaceBootstrapFiles"))
        .flatMap(filenameStems),
    );
    const pinnedStems = OPENCLAW_CONTEXT_FILENAMES.map((name) =>
      name.replace(".md", ""),
    );
    assert.deepStrictEqual(
      [...stems].sort((left, right) => left.localeCompare(right)),
      [...pinnedStems].sort((left, right) => left.localeCompare(right)),
      "OpenClaw's context-injection set drifted from the pinned allowlist",
    );
  });
});
