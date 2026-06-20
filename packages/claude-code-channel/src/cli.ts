#!/usr/bin/env node

/**
 * Stdio MCP-server entry — what Claude Code (`claude --mcp-config ...`)
 * subprocess-spawns to bring this channel online.
 *
 * Lets the MoltZap client load its connection config, calls
 * `bootClaudeCodeChannel`,
 * and holds the process open. stdin/stdout speak MCP JSON-RPC for the
 * `claude` parent; stderr carries diagnostic logs so the parent's stdout
 * isn't corrupted.
 *
 * Environment contract:
 *   MOLTZAP_PROFILE — named MoltZap profile to load (required)
 *   MOLTZAP_SERVER_NAME — optional MCP server name override (defaults to package default)
 *
 * Failure modes exit with code 1 and a diagnostic line on stderr.
 */
import { bootClaudeCodeChannel } from "./entry.js";
import { Config, ConfigError, Data, Effect, Logger, Option } from "effect";

class ChannelMainError extends Data.TaggedError("ChannelMainError")<{
  readonly cause: unknown;
}> {}

interface RuntimeConfig {
  readonly profileName: string;
  readonly serverName?: string;
}

function loadRuntimeConfig(): Effect.Effect<
  RuntimeConfig,
  ConfigError.ConfigError
> {
  return Effect.gen(function* () {
    const profileName = yield* Config.string("MOLTZAP_PROFILE");
    const serverName = Option.getOrUndefined(
      yield* Config.option(Config.string("MOLTZAP_SERVER_NAME")),
    );
    return {
      profileName,
      ...(serverName === undefined || serverName.length === 0
        ? {}
        : { serverName }),
    };
  });
}

const StderrLoggerLive = Logger.replace(
  Logger.defaultLogger,
  Logger.withConsoleError(Logger.stringLogger),
);

function main(): Effect.Effect<
  void,
  ChannelMainError | ConfigError.ConfigError,
  never
> {
  return Effect.gen(function* () {
    const { profileName, serverName } = yield* loadRuntimeConfig();
    const result = yield* Effect.tryPromise({
      try: () =>
        bootClaudeCodeChannel({
          profileName,
          ...(serverName === undefined ? {} : { serverName }),
        }),
      catch: (cause) => new ChannelMainError({ cause }),
    });
    if (result._tag === "Err") {
      return yield* Effect.fail(
        new ChannelMainError({
          cause: `${result.error._tag}: ${result.error.cause}`,
        }),
      );
    }

    // Adapter readiness is observed by the moltzap server's ConnectionManager
    // once the WS auth completes. The MCP stdio server stays alive driving the
    // `notifications/claude/channel` and `reply` tool calls; teardown is
    // signal-driven (SIGTERM from the parent runtime adapter).
    yield* Effect.logInfo("moltzap-claude-code-channel: ready");
  });
}

function startupFailureCause(
  err: ChannelMainError | ConfigError.ConfigError,
): string {
  if (err instanceof ChannelMainError) return String(err.cause);
  return String(err);
}

function logStartupFailure(
  err: ChannelMainError | ConfigError.ConfigError,
): Effect.Effect<void> {
  return Effect.logError("moltzap-claude-code-channel: startup failed").pipe(
    Effect.annotateLogs({ cause: startupFailureCause(err) }),
  );
}

Effect.runPromise(
  main().pipe(
    Effect.tapError(logStartupFailure),
    Effect.provide(StderrLoggerLive),
  ),
).catch(() => {
  process.exit(1);
});
