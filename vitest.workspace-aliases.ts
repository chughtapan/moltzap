import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Alias } from "vite";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function fromRoot(...segments: string[]): string {
  return path.join(repoRoot, ...segments);
}

export const workspaceSourceAliases: Alias[] = [
  {
    find: /^@moltzap\/server-core\/test-utils$/,
    replacement: fromRoot("packages/server/src/test-utils/index.ts"),
  },
  {
    find: /^@moltzap\/server-core$/,
    replacement: fromRoot("packages/server/src/index.ts"),
  },
  {
    find: /^@moltzap\/client\/test-utils$/,
    replacement: fromRoot("packages/client/src/test-utils/index.ts"),
  },
  {
    find: /^@moltzap\/client\/test$/,
    replacement: fromRoot("packages/client/src/test/index.ts"),
  },
  {
    find: /^@moltzap\/client$/,
    replacement: fromRoot("packages/client/src/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/schemas$/,
    replacement: fromRoot("packages/protocol/src/schema/index.ts"),
  },
  {
    find: /^@moltzap\/protocol$/,
    replacement: fromRoot("packages/protocol/src/index.ts"),
  },
  {
    find: /^@moltzap\/openclaw-channel\/test-utils$/,
    replacement: fromRoot(
      "packages/openclaw-channel/src/test-utils/container-core.ts",
    ),
  },
  {
    find: /^@moltzap\/openclaw-channel$/,
    replacement: fromRoot("packages/openclaw-channel/src/openclaw-entry.ts"),
  },
];
