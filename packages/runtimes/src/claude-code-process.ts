/**
 * Internal config + plugin-install helpers for the Claude Code runtime
 * adapter (issue #255).
 *
 * Mirrors `openclaw-adapter.ts`'s module-private `writeOpenClawConfig` /
 * `installChannelPlugin` shape, projected onto Claude Code's spawn surface:
 *   - `writeClaudeCodeMcpConfig` — emits the `claude --mcp-config` JSON
 *     pointing at the disk-installed channel plugin's `bin` script.
 *   - `installChannelPlugin` — copies cc-channel's `dist/` + `package.json`
 *     into the agent state dir, then symlinks `@moltzap/protocol`,
 *     `@moltzap/client`, `@modelcontextprotocol/sdk`, and `effect` into the
 *     plugin's local `node_modules` so the plugin's imports resolve at
 *     MCP-load time without depending on the parent's resolution paths.
 *   - `seedWorkspaceFiles` — same shape as openclaw's helper.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SpawnInput } from "./runtime.js";

export interface WriteClaudeCodeMcpConfigOpts {
  readonly stateDir: string;
  readonly extDir: string;
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly agentName: string;
}

/**
 * MCP server name as it appears under `mcpServers.<name>` in the JSON
 * config Claude Code reads. Cold-read: `moltzap` because Claude Code's
 * channel-tag rendering is keyed on the plugin's own MCP namespace, not
 * this server name; this string is only the local config alias.
 */
const MCP_SERVER_ALIAS = "moltzap";

interface ClaudeCodeMcpConfig {
  readonly mcpServers: {
    readonly [name: string]: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    };
  };
}

export function writeClaudeCodeMcpConfig(
  opts: WriteClaudeCodeMcpConfigOpts,
): string {
  // The cc-channel ws-client expects http(s):// urls; strip /ws and flip
  // ws→http (same normalization as openclaw / nanoclaw adapters).
  const serverUrl = opts.serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:");

  const binPath = path.join(opts.extDir, "dist", "bin.js");

  const config: ClaudeCodeMcpConfig = {
    mcpServers: {
      [MCP_SERVER_ALIAS]: {
        command: "node",
        args: [binPath],
        env: {
          MOLTZAP_API_KEY: opts.apiKey,
          MOLTZAP_SERVER_URL: serverUrl,
          MOLTZAP_SERVER_NAME: `@moltzap/claude-code-channel/${opts.agentName}`,
        },
      },
    },
  };

  const configPath = path.join(opts.stateDir, "mcp-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

export function seedWorkspaceFiles(
  stateDir: string,
  workspaceFiles: SpawnInput["workspaceFiles"],
): void {
  if (workspaceFiles === undefined) {
    return;
  }
  const workspaceDir = path.join(stateDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const file of workspaceFiles) {
    const destination = path.join(workspaceDir, file.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }
}

export function installChannelPlugin(
  stateDir: string,
  channelDistDir: string,
  repoRoot: string,
): string {
  const extDir = path.join(stateDir, "extensions", "claude-code-channel");
  const channelPackageDir = path.dirname(channelDistDir);
  fs.mkdirSync(path.dirname(extDir), { recursive: true });

  // Copy the plugin package: dist/ + package.json. Claude Code's MCP
  // command points at the in-state-dir bin path; the plugin's package.json
  // gets copied so node's module resolution starts from the plugin root.
  fs.mkdirSync(extDir, { recursive: true });
  fs.cpSync(channelDistDir, path.join(extDir, "dist"), {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = path.relative(channelDistDir, src);
      return !rel.startsWith("node_modules") && !rel.startsWith("src");
    },
  });
  const packageJsonPath = path.join(channelPackageDir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    fs.copyFileSync(packageJsonPath, path.join(extDir, "package.json"));
  }

  // Symlink the runtime imports cc-channel resolves at MCP-load time.
  // Without these the spawned bin would fail in the state dir's isolated
  // resolution. Mirrors openclaw's `installChannelPlugin` logic.
  const pluginNm = path.join(extDir, "node_modules");
  fs.mkdirSync(path.join(pluginNm, "@moltzap"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "packages/protocol"),
    path.join(pluginNm, "@moltzap/protocol"),
    "dir",
  );
  fs.symlinkSync(
    path.join(repoRoot, "packages/client"),
    path.join(pluginNm, "@moltzap/client"),
    "dir",
  );
  // The MCP SDK is a runtime dep of cc-channel (`@modelcontextprotocol/sdk`)
  // and `effect` is a workspace-pinned dep used by both cc-channel and
  // @moltzap/client. Both have to resolve from the plugin's node_modules.
  fs.mkdirSync(path.join(pluginNm, "@modelcontextprotocol"), {
    recursive: true,
  });
  symlinkPreferring(
    [
      path.join(channelPackageDir, "node_modules/@modelcontextprotocol/sdk"),
      path.join(repoRoot, "node_modules/@modelcontextprotocol/sdk"),
    ],
    path.join(pluginNm, "@modelcontextprotocol/sdk"),
  );
  symlinkPreferring(
    [
      path.join(channelPackageDir, "node_modules/effect"),
      path.join(repoRoot, "node_modules/effect"),
    ],
    path.join(pluginNm, "effect"),
  );

  return extDir;
}

function symlinkPreferring(
  candidates: ReadonlyArray<string>,
  target: string,
): void {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      fs.symlinkSync(candidate, target, "dir");
      return;
    }
  }
  throw new Error(
    `claude-code adapter: none of the candidate paths exist for ${target}: ${candidates.join(", ")}`,
  );
}
