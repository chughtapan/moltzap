/**
 * Claude-Code-specific config helpers.
 *
 * The plugin-install + workspace-seed helpers live in
 * `channel-plugin-install.ts` so openclaw and claude-code share one
 * implementation. What stays here is the bit unique
 * to claude-code: the MCP-config JSON `claude --mcp-config` reads.
 */
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect } from "effect";
import type { BootOptions as ClaudeCodeChannelBootOptions } from "@moltzap/claude-code-channel";

const JSON_INDENT_SPACES = 2;

export interface WriteClaudeCodeMcpConfigOpts {
  readonly stateDir: string;
  readonly extDir: string;
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly agentName: string;
}

/**
 * MCP server name as it appears under `mcpServers.&lt;name>` in the JSON
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

type ClaudeCodeChannelServerName = NonNullable<
  ClaudeCodeChannelBootOptions["serverName"]
>;

export function writeClaudeCodeMcpConfig(
  opts: WriteClaudeCodeMcpConfigOpts,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem | Path.Path> {
  // The cc-channel ws-client expects http(s):// urls; strip /ws and flip
  // ws→http (same normalization as openclaw / nanoclaw adapters).
  const serverUrl = opts.serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:");

  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const binPath = path.join(opts.extDir, "dist", "cli.js");
    const channelServerName: ClaudeCodeChannelServerName = `@moltzap/claude-code-channel/${opts.agentName}`;

    const config: ClaudeCodeMcpConfig = {
      mcpServers: {
        [MCP_SERVER_ALIAS]: {
          command: "node",
          args: [binPath],
          env: {
            MOLTZAP_API_KEY: opts.apiKey,
            MOLTZAP_SERVER_URL: serverUrl,
            MOLTZAP_SERVER_NAME: channelServerName,
          },
        },
      },
    };

    const configPath = path.join(opts.stateDir, "mcp-config.json");
    yield* fileSystem.writeFileString(
      configPath,
      JSON.stringify(config, null, JSON_INDENT_SPACES),
    );
    return configPath;
  }).pipe(Effect.withSpan("writeClaudeCodeMcpConfig"));
}
