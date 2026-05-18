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
import {
  Config,
  ConfigError,
  Data,
  Effect,
  Logger,
  Option,
  Redacted,
} from "effect";

class ChannelMainError extends Data.TaggedError("ChannelMainError")<{
  readonly cause: unknown;
}> {}

interface RuntimeConfig {
  readonly apiKey: string;
  readonly serverUrl: string;
  readonly serverName?: string;
}

function loadRuntimeConfig(): Effect.Effect<
  RuntimeConfig,
  ConfigError.ConfigError
> {
  return Effect.gen(function* () {
    const redactedApiKey = yield* Config.redacted("MOLTZAP_API_KEY").pipe(
      Config.validate({
        message: "MOLTZAP_API_KEY env var is required",
        validation: (value) => Redacted.value(value).length > 0,
      }),
    );
    const apiKey = Redacted.value(redactedApiKey);
    const serverUrl = yield* Config.string("MOLTZAP_SERVER_URL").pipe(
      Config.validate({
        message: "MOLTZAP_SERVER_URL env var is required",
        validation: (value) => value.length > 0,
      }),
    );
    const serverName = Option.getOrUndefined(
      yield* Config.option(Config.string("MOLTZAP_SERVER_NAME")),
    );
    return {
      apiKey,
      serverUrl,
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
    const { apiKey, serverUrl, serverName } = yield* loadRuntimeConfig();
    const result = yield* Effect.tryPromise({
      try: () =>
        bootClaudeCodeChannel({
          serverUrl,
          agentKey: apiKey,
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
  return err instanceof ChannelMainError ? String(err.cause) : String(err);
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
