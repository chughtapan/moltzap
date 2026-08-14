/** @file Pins OpenClaw workspace reachability and injection-set drift. */

import { assert, describe, it } from "@effect/vitest";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- this canary reads the installed OpenClaw distribution synchronously.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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

  it("accepts injected filenames when every tool is denied", () => {
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
  it("matches the installed OpenClaw bootstrap loader entries", () => {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve("openclaw/plugin-sdk");
    const distIndex = sdkEntry.indexOf(`${path.sep}dist${path.sep}`);
    assert.isAbove(distIndex, 0, "openclaw's dist directory moved");
    const distDirectory = sdkEntry.slice(0, distIndex + 5);
    const stems = new Set<string>(
      fs
        .readdirSync(distDirectory)
        // OpenClaw emits this loader only into bootstrap/workspace chunks. A
        // focused scan keeps the installed-package canary cheap under load.
        .filter((name) => /^(?:bootstrap|workspace)-.*\.js$/u.test(name))
        .map((name) => fs.readFileSync(path.join(distDirectory, name), "utf8"))
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
