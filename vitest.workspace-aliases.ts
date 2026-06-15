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
  // Specific subpath matchers must precede each package's root matcher.
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
    find: /^#rpc$/,
    replacement: fromRoot("packages/protocol/src/rpc/index.ts"),
  },
  {
    find: /^#identity$/,
    replacement: fromRoot("packages/protocol/src/identity/index.ts"),
  },
  {
    find: /^#identity\/agents$/,
    replacement: fromRoot("packages/protocol/src/identity/agents/index.ts"),
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
    replacement: fromRoot("packages/protocol/src/identity/contacts/index.ts"),
  },
  {
    find: /^#identity\/contacts\/requirements$/,
    replacement: fromRoot(
      "packages/protocol/src/identity/contacts/requirements/index.ts",
    ),
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
    find: /^#network$/,
    replacement: fromRoot("packages/protocol/src/network/index.ts"),
  },
  {
    find: /^#task$/,
    replacement: fromRoot("packages/protocol/src/task/index.ts"),
  },
  {
    find: /^#task\/requirements$/,
    replacement: fromRoot("packages/protocol/src/task/requirements/index.ts"),
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
    find: /^#message\/dispatch$/,
    replacement: fromRoot("packages/protocol/src/message/dispatch.ts"),
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
    find: /^@moltzap\/protocol\/testing$/,
    replacement: fromRoot("packages/protocol/src/testing/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/rpc$/,
    replacement: fromRoot("packages/protocol/src/rpc/index.ts"),
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
    find: /^@moltzap\/protocol\/conversation$/,
    replacement: fromRoot("packages/protocol/src/conversation/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/message$/,
    replacement: fromRoot("packages/protocol/src/message/index.ts"),
  },
  {
    find: /^@moltzap\/protocol\/message\/dispatch$/,
    replacement: fromRoot("packages/protocol/src/message/dispatch.ts"),
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

const protocolSourceRoot = fromRoot("packages/protocol/src");

export const workspaceSourceAliasesWithoutProtocol: WorkspaceSourceAlias[] =
  workspaceSourceAliases.filter(
    (alias) => !alias.replacement.startsWith(protocolSourceRoot),
  );

export const serverCoreSourceAliases: WorkspaceSourceAlias[] = [
  {
    find: /^#core$/,
    replacement: fromRoot("packages/server/src/core/index.ts"),
  },
  {
    find: /^#socket$/,
    replacement: fromRoot("packages/server/src/socket/index.ts"),
  },
  {
    find: /^#http$/,
    replacement: fromRoot("packages/server/src/http/index.ts"),
  },
  {
    find: /^#db$/,
    replacement: fromRoot("packages/server/src/db/client.ts"),
  },
  {
    find: /^#identity\/agents$/,
    replacement: fromRoot("packages/server/src/identity/agents/index.ts"),
  },
  {
    find: /^#identity\/apps$/,
    replacement: fromRoot("packages/server/src/identity/apps/index.ts"),
  },
  {
    find: /^#identity\/contacts$/,
    replacement: fromRoot("packages/server/src/identity/contacts/index.ts"),
  },
  {
    find: /^#identity\/contacts\/requirements$/,
    replacement: fromRoot(
      "packages/server/src/identity/contacts/requirements/index.ts",
    ),
  },
  {
    find: /^#network$/,
    replacement: fromRoot("packages/server/src/network/index.ts"),
  },
  {
    find: /^#network\/presence$/,
    replacement: fromRoot("packages/server/src/network/presence/index.ts"),
  },
  {
    find: /^#task$/,
    replacement: fromRoot("packages/server/src/task/index.ts"),
  },
  {
    find: /^#task\/handlers$/,
    replacement: fromRoot("packages/server/src/task/handlers.ts"),
  },
  {
    find: /^#task\/requirements$/,
    replacement: fromRoot("packages/server/src/task/requirements/index.ts"),
  },
  {
    find: /^#conversation$/,
    replacement: fromRoot("packages/server/src/conversation/index.ts"),
  },
  {
    find: /^#conversation\/handlers$/,
    replacement: fromRoot("packages/server/src/conversation/handlers.ts"),
  },
  {
    find: /^#conversation\/requirements$/,
    replacement: fromRoot(
      "packages/server/src/conversation/requirements/index.ts",
    ),
  },
  {
    find: /^#message$/,
    replacement: fromRoot("packages/server/src/message/index.ts"),
  },
  {
    find: /^#message\/handlers$/,
    replacement: fromRoot("packages/server/src/message/handlers.ts"),
  },
  {
    find: /^#dispatch$/,
    replacement: fromRoot("packages/server/src/dispatch/index.ts"),
  },
  {
    find: /^#dispatch\/handlers$/,
    replacement: fromRoot("packages/server/src/dispatch/handlers.ts"),
  },
  {
    find: /^#test-utils$/,
    replacement: fromRoot("packages/server/src/test-utils/index.ts"),
  },
];
