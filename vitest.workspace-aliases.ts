/** @file Workspace source aliases shared by Vitest project configurations. */

import path from "node:path";
import { fileURLToPath } from "node:url";

interface WorkspaceSourceAlias {
  readonly find: string | RegExp;
  readonly replacement: string;
}

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function alias(specifier: string, ...segments: string[]): WorkspaceSourceAlias {
  return {
    find: new RegExp(`^${specifier}$`),
    replacement: fromRoot(...segments),
  };
}

function fromRoot(...segments: string[]): string {
  return path.join(repoRoot, ...segments);
}

/**
 * Workspace packages a suite consumes as built output rather than through a
 * source alias below.
 *
 * Vitest inlines a linked workspace package by default and then resolves that
 * package's own imports against the importing project, so `dist` reaching for
 * `jose` fails wherever the importer does not itself declare it. Keeping these
 * external returns them to Node's resolution, which finds `jose` under each
 * package's own `node_modules`. Declaring `jose` in the importer instead would
 * be a dependency no source file imports, which knip rejects.
 */
export const builtWorkspaceDependencies: RegExp[] = [
  /@moltzap\/(?:identity|router)/,
];

/** Source aliases, ordered with specific subpaths before package roots. */
export const workspaceSourceAliases: WorkspaceSourceAlias[] = [
  alias("@moltzap/client", "packages/client/src/index.ts"),
  alias("@moltzap/simulator/ledger", "packages/simulator/src/ledger/index.ts"),
  alias("@moltzap/simulator", "packages/simulator/src/index.ts"),
  alias(
    "@moltzap/nanoclaw-channel",
    "packages/nanoclaw-channel/src/channels/moltzap.ts",
  ),
  alias("@moltzap/openclaw-channel", "packages/openclaw-channel/src/plugin.ts"),
];
