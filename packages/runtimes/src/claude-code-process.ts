/**
 * Claude-Code-specific config helpers (issue #255).
 *
 * The plugin-install + workspace-seed helpers live in
 * `channel-plugin-install.ts` so openclaw and claude-code share one
 * implementation (issue #272 item 8). What stays here is the bit unique
 * to claude-code: the MCP-config JSON `claude --mcp-config` reads.
 */
import * as fs from "node:fs";
import * as path from "node:path";

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
