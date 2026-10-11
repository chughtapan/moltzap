#!/usr/bin/env node
/** @file Renders the packaged common and platform-specific install prompt; makes no account or infrastructure change. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Data, Effect } from "effect";
import { fileURLToPath } from "node:url";

const leaves = new Map([
  ["muse", "muse/install.md"],
  ["instinct", "instinct/install.md"],
  ["grokbot", "grokbot/install.md"],
  ["openclaw", "openclaw/install.md"],
  ["dot", "openai-dot/install.md"],
]);
const args = process.argv.slice(2);
const leaf = args.length === 1 ? leaves.get(args[0]) : undefined;

class InstallPromptUnavailable extends Data.TaggedError(
  "InstallPromptUnavailable",
) {}

if (leaf === undefined) {
  process.stderr.write(
    "usage: install-prompt.mjs muse|instinct|grokbot|openclaw|dot\n",
  );
  process.exitCode = 64;
} else {
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = ["install.md", leaf].map((path) =>
      fileURLToPath(new URL(`../${path}`, import.meta.url)),
    );
    const content = yield* Effect.forEach(paths, (path) =>
      fs.readFileString(path),
    );
    yield* Effect.sync(() => process.stdout.write(`${content.join("\n\n")}\n`));
  }).pipe(
    Effect.catchAll(() => Effect.fail(new InstallPromptUnavailable())),
    Effect.provide(NodeFileSystem.layer),
    NodeRuntime.runMain,
  );
}
