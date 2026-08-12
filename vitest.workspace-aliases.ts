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

function alias(specifier: string, ...segments: string[]): WorkspaceSourceAlias {
  return {
    find: new RegExp(`^${specifier}$`),
    replacement: fromRoot(...segments),
  };
}

/** Source aliases, ordered with specific subpaths before package roots. */
export const workspaceSourceAliases: WorkspaceSourceAlias[] = [
  alias(
    "@moltzap/server-core/test-utils",
    "packages/server/src/test-utils/index.ts",
  ),
  alias(
    "@moltzap/server-core/identity",
    "packages/server/src/identity/index.ts",
  ),
  alias("@moltzap/server-core/network", "packages/server/src/network/index.ts"),
  alias("@moltzap/server-core/task", "packages/server/src/task/index.ts"),
  alias("@moltzap/server-core", "packages/server/src/index.ts"),
  alias(
    "@moltzap/client/test-utils",
    "packages/client/src/test-utils/index.ts",
  ),
  alias("@moltzap/client/test", "packages/client/src/test/index.ts"),
  alias("@moltzap/client/runtime", "packages/client/src/runtime/index.ts"),
  alias("@moltzap/client", "packages/client/src/index.ts"),
  alias("#transport", "packages/protocol/src/transport/index.ts"),
  alias(
    "#transport/descriptor",
    "packages/protocol/src/transport/descriptor.ts",
  ),
  alias("#rpc", "packages/protocol/src/rpc.ts"),
  alias("#identity", "packages/protocol/src/identity/index.ts"),
  alias("#identity/agents", "packages/protocol/src/identity/agents/index.ts"),
  alias("#identity/apps", "packages/protocol/src/identity/apps/index.ts"),
  alias("#identity/users", "packages/protocol/src/identity/users/index.ts"),
  alias(
    "#identity/principals",
    "packages/protocol/src/identity/principals/index.ts",
  ),
  alias(
    "#identity/requirements",
    "packages/protocol/src/identity/requirements/index.ts",
  ),
  alias("#network", "packages/protocol/src/network/index.ts"),
  alias("#conversation", "packages/protocol/src/conversation/index.ts"),
  alias(
    "#conversation/requirements",
    "packages/protocol/src/conversation/requirements/index.ts",
  ),
  alias("#message", "packages/protocol/src/message/index.ts"),
  alias("#message/dispatch", "packages/protocol/src/message/dispatch.ts"),
  alias("#socket", "packages/protocol/src/socket/index.ts"),
  alias("#testing", "packages/protocol/src/testing/index.ts"),
  alias("@moltzap/protocol/testing", "packages/protocol/src/testing/index.ts"),
  alias("@moltzap/protocol/rpc", "packages/protocol/src/rpc.ts"),
  alias(
    "@moltzap/protocol/identity",
    "packages/protocol/src/identity/index.ts",
  ),
  alias("@moltzap/protocol/network", "packages/protocol/src/network/index.ts"),
  alias(
    "@moltzap/protocol/conversation",
    "packages/protocol/src/conversation/index.ts",
  ),
  alias("@moltzap/protocol/message", "packages/protocol/src/message/index.ts"),
  alias(
    "@moltzap/protocol/message/dispatch",
    "packages/protocol/src/message/dispatch.ts",
  ),
  alias("@moltzap/protocol/socket", "packages/protocol/src/socket/index.ts"),
  alias("@moltzap/protocol", "packages/protocol/src/index.ts"),
  alias("@moltzap/simulator/network", "packages/simulator/src/network.ts"),
  alias("@moltzap/simulator/ledger", "packages/simulator/src/ledger.ts"),
  alias("@moltzap/simulator", "packages/simulator/src/index.ts"),
  alias(
    "@moltzap/nanoclaw-channel",
    "packages/nanoclaw-channel/src/channels/moltzap.ts",
  ),
  alias(
    "@moltzap/openclaw-channel",
    "packages/openclaw-channel/src/openclaw-entry.ts",
  ),
];

const protocolSourceRoot = fromRoot("packages/protocol/src");

/** Source aliases for suites that consume the built protocol package. */
export const workspaceSourceAliasesWithoutProtocol: WorkspaceSourceAlias[] =
  workspaceSourceAliases.filter(
    (entry) => !entry.replacement.startsWith(protocolSourceRoot),
  );

/** Source aliases for server-internal package imports. */
export const serverCoreSourceAliases: WorkspaceSourceAlias[] = [
  alias("#core", "packages/server/src/core/index.ts"),
  alias("#moltzap", "packages/server/src/moltzap/index.ts"),
  alias("#moltzap/runtime", "packages/server/src/moltzap/runtime.ts"),
  alias("#socket", "packages/server/src/socket/index.ts"),
  alias("#http", "packages/server/src/http/index.ts"),
  alias("#config", "packages/server/src/config.ts"),
  alias("#config/secrets", "packages/server/src/config/secrets.ts"),
  alias("#db", "packages/server/src/db/barrel.ts"),
  alias("#db/crypto", "packages/server/src/db/crypto/barrel.ts"),
  alias("#identity/agents", "packages/server/src/identity/agents/index.ts"),
  alias("#identity/apps", "packages/server/src/identity/apps/index.ts"),
  alias(
    "#identity/credential-keys",
    "packages/server/src/identity/credential-keys.ts",
  ),
  alias("#network", "packages/server/src/network/index.ts"),
  alias("#conversation", "packages/server/src/conversation/index.ts"),
  alias(
    "#conversation/handlers",
    "packages/server/src/conversation/handlers.ts",
  ),
  alias(
    "#conversation/requirements",
    "packages/server/src/conversation/requirements/index.ts",
  ),
  alias("#message", "packages/server/src/message/index.ts"),
  alias("#message/handlers", "packages/server/src/message/handlers.ts"),
  alias("#dispatch", "packages/server/src/dispatch/index.ts"),
  alias("#dispatch/handlers", "packages/server/src/dispatch/handlers.ts"),
  alias("#test-utils", "packages/server/src/test-utils/index.ts"),
];
