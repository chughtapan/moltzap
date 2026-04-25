#!/usr/bin/env node
/**
 * Stdio MCP-server entry — what Claude Code (`claude --mcp-config ...`)
 * subprocess-spawns to bring this channel online.
 *
 * Reads the moltzap connection config from environment variables (the
 * MCP config's `env:` block sets these), calls `bootClaudeCodeChannel`,
 * and holds the process open. stdin/stdout speak MCP JSON-RPC for the
 * `claude` parent; stderr carries diagnostic logs so the parent's stdout
 * isn't corrupted.
 *
 * Environment contract:
 *   MOLTZAP_API_KEY    — agent api key (required)
 *   MOLTZAP_SERVER_URL — moltzap server url (required, http(s)://host[:port] form)
 *   MOLTZAP_SERVER_NAME — optional MCP server name override (defaults to package default)
 *
 * Failure modes exit with code 1 and a diagnostic line on stderr.
 */
import { bootClaudeCodeChannel } from "./entry.js";

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: top-level subprocess entry — main wraps the boot Promise behind a single error boundary
async function main(): Promise<void> {
  const apiKey = process.env.MOLTZAP_API_KEY;
  const serverUrl = process.env.MOLTZAP_SERVER_URL;
  if (apiKey === undefined || apiKey.length === 0) {
    process.stderr.write(
      "moltzap-claude-code-channel: MOLTZAP_API_KEY env var is required\n",
    );
    process.exit(1);
  }
  if (serverUrl === undefined || serverUrl.length === 0) {
    process.stderr.write(
      "moltzap-claude-code-channel: MOLTZAP_SERVER_URL env var is required\n",
    );
    process.exit(1);
  }

  // Logger writes to stderr — stdout is reserved for MCP JSON-RPC framing.
  // Variadic `unknown[]` matches @moltzap/client's `WsClientLogger` shape
  // (ws-client.ts:110).
  const logger = {
    info: (...args: unknown[]): void => {
      process.stderr.write(`[info] ${formatLogArgs(args)}\n`);
    },
    warn: (...args: unknown[]): void => {
      process.stderr.write(`[warn] ${formatLogArgs(args)}\n`);
    },
    error: (...args: unknown[]): void => {
      process.stderr.write(`[error] ${formatLogArgs(args)}\n`);
    },
  };

  const opts: Parameters<typeof bootClaudeCodeChannel>[0] = {
    serverUrl,
    agentKey: apiKey,
    logger,
  };
  if (
    typeof process.env.MOLTZAP_SERVER_NAME === "string" &&
    process.env.MOLTZAP_SERVER_NAME.length > 0
  ) {
    Object.assign(opts, { serverName: process.env.MOLTZAP_SERVER_NAME });
  }

  const result = await bootClaudeCodeChannel(opts);
  if (result._tag === "Err") {
    process.stderr.write(
      `[error] moltzap-claude-code-channel: bootClaudeCodeChannel failed: ${result.error._tag}: ${result.error.cause}\n`,
    );
    process.exit(1);
  }

  // Adapter readiness is observed by the moltzap server's ConnectionManager
  // once the WS auth completes. The MCP stdio server stays alive driving the
  // `notifications/claude/channel` and `reply` tool calls; teardown is
  // signal-driven (SIGTERM from the parent runtime adapter).
  process.stderr.write("[info] moltzap-claude-code-channel: ready\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
    // #ignore-sloppy-code-next-line[bare-catch]: log formatting fallback — circular refs etc. are not actionable here
  } catch (_err) {
    void _err;
    return String(value);
  }
}

function formatLogArgs(args: ReadonlyArray<unknown>): string {
  return args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
}

void main().catch((err: unknown) => {
  process.stderr.write(
    `[error] moltzap-claude-code-channel: uncaught ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
