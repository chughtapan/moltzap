import path from "node:path";
import { fileURLToPath } from "node:url";

interface WorkspaceSourceAlias {
  readonly find: string | RegExp;
  readonly replacement: string;
}

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function fromRoot(...segments: string[]): string {
  return path.join(repoRoot, ...segments);
}

export const workspaceSourceAliases: WorkspaceSourceAlias[] = [
  {
    find: /^@moltzap\/server-core\/test-utils$/,
    replacement: fromRoot("packages/server/src/test-utils/index.ts"),
  },
  // Phase 2A r2 — subpath exports for protocol-aligned layers. The matcher
  // order matters: more-specific subpath matchers (`/transport`, `/identity`,
  // `/network`, `/task`, `/app`) must precede the bare `@moltzap/server-core`
  // entry.
  {
    find: /^@moltzap\/server-core\/transport$/,
    replacement: fromRoot("packages/server/src/transport/index.ts"),
  },
  {
    find: /^@moltzap\/server-core\/identity$/,
    replacement: fromRoot("packages/server/src/identity/index.ts"),
  },
  {
    find: /^@moltzap\/server-core\/network$/,
    replacement: fromRoot("packages/server/src/network/index.ts"),
  },
  {
    find: /^@moltzap\/server-core\/task$/,
    replacement: fromRoot("packages/server/src/task/index.ts"),
  },
  {
    find: /^@moltzap\/server-core\/app$/,
    replacement: fromRoot("packages/server/src/app/index.ts"),
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
    find: /^@moltzap\/client\/runtime$/,
    replacement: fromRoot("packages/client/src/runtime/index.ts"),
  },
  {
    find: /^@moltzap\/client$/,
    replacement: fromRoot("packages/client/src/index.ts"),
  },
  {
    find: /^#transport$/,
    replacement: fromRoot("packages/protocol/src/transport/index.ts"),
  },
  {
    find: /^#identity$/,
    replacement: fromRoot("packages/protocol/src/identity/index.ts"),
  },
  {
    find: /^#identity\/principals$/,
    replacement: fromRoot("packages/protocol/src/identity/principals/index.ts"),
  },
  {
    find: /^#identity\/requirements$/,
    replacement: fromRoot(
      "packages/protocol/src/identity/requirements/index.ts",
    ),
  },
  {
    find: /^#identity\/agents$/,
    replacement: fromRoot("packages/protocol/src/identity/agents.ts"),
  },
  {
    find: /^#identity\/apps$/,
    replacement: fromRoot("packages/protocol/src/identity/apps/index.ts"),
  },
  {
    find: /^#identity\/users$/,
    replacement: fromRoot("packages/protocol/src/identity/users/index.ts"),
  },
  {
    find: /^#identity\/contacts$/,
    replacement: fromRoot("packages/protocol/src/identity/contacts.ts"),
  },
  {
    find: /^#identity\/contacts\/requirements$/,
    replacement: fromRoot(
      "packages/protocol/src/identity/contacts/requirements/index.ts",
    ),
  },
  {
    find: /^#network$/,
    replacement: fromRoot("packages/protocol/src/network/index.ts"),
  },
  {
    find: /^#task$/,
    replacement: fromRoot("packages/protocol/src/task/index.ts"),
  },
  {
    find: /^#task\/requirements$/,
    replacement: fromRoot("packages/protocol/src/task/capabilities/index.ts"),
  },
  {
    find: /^#conversation$/,
    replacement: fromRoot("packages/protocol/src/conversation/index.ts"),
  },
  {
    find: /^#conversation\/requirements$/,
    replacement: fromRoot(
      "packages/protocol/src/conversation/requirements/index.ts",
    ),
  },
  {
    find: /^#message$/,
    replacement: fromRoot("packages/protocol/src/message/index.ts"),
  },
  {
    find: /^#dispatch$/,
    replacement: fromRoot("packages/protocol/src/dispatch/index.ts"),
  },
  {
    find: /^#socket$/,
    replacement: fromRoot("packages/protocol/src/socket/index.ts"),
  },
  {
    find: /^#testing$/,
    replacement: fromRoot("packages/protocol/src/testing/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/schemas$/,
    replacement: fromRoot("packages/protocol/src/schema/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/testing$/,
    replacement: fromRoot("packages/protocol/src/testing/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/transport$/,
    replacement: fromRoot("packages/protocol/src/transport/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/identity$/,
    replacement: fromRoot("packages/protocol/src/identity/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/network$/,
    replacement: fromRoot("packages/protocol/src/network/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/task$/,
    replacement: fromRoot("packages/protocol/src/task/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/app$/,
    replacement: fromRoot("packages/protocol/src/app/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/socket$/,
    replacement: fromRoot("packages/protocol/src/socket/index.ts"),
  },
  {
    find: /^@moltzap\/protocol$/,
    replacement: fromRoot("packages/protocol/src/index.ts"),
  },
  {
    find: /^@moltzap\/openclaw-channel$/,
    replacement: fromRoot("packages/openclaw-channel/src/openclaw-entry.ts"),
  },
];
