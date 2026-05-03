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
import { Config, ConfigError, Data, Effect, Option } from "effect";

class ChannelMainError extends Data.TaggedError("ChannelMainError")<{
  readonly cause: unknown;
}> {}

function main(): Effect.Effect<
  void,
  ChannelMainError | ConfigError.ConfigError,
  never
> {
  return Effect.gen(function* () {
    const apiKey = yield* Config.string("MOLTZAP_API_KEY").pipe(
      Config.validate({
        message: "MOLTZAP_API_KEY env var is required",
        validation: (value) => value.length > 0,
      }),
    );
    const serverUrl = yield* Config.string("MOLTZAP_SERVER_URL").pipe(
      Config.validate({
        message: "MOLTZAP_SERVER_URL env var is required",
        validation: (value) => value.length > 0,
      }),
    );

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

    const serverName = Option.getOrUndefined(
      yield* Config.option(Config.string("MOLTZAP_SERVER_NAME")),
    );
    const result = yield* Effect.tryPromise({
      try: () =>
        bootClaudeCodeChannel({
          serverUrl,
          agentKey: apiKey,
          logger,
          ...(typeof serverName === "string" && serverName.length > 0
            ? { serverName }
            : {}),
        }),
      catch: (cause) => new ChannelMainError({ cause }),
    });
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
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (jsonErr) {
    const reason = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
    return `${String(value)} (json serialization failed: ${reason})`;
  }
}

function formatLogArgs(args: ReadonlyArray<unknown>): string {
  return args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
}

void Effect.runPromise(main()).catch((err: unknown) => {
  process.stderr.write(
    `[error] moltzap-claude-code-channel: uncaught ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
