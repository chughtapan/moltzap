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
