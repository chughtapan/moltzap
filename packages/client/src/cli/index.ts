#!/usr/bin/env node
/** @file MoltZap CLI entrypoint and global transport option wiring. */
import { Args, Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import {
  Config,
  ConfigProvider,
  Effect,
  Layer,
  Logger,
  LogLevel,
  Option,
} from "effect";
import packageJson from "../../package.json" with { type: "json" };
import { contactsCommand } from "./commands/contacts.js";
import {
  conversationsCommand,
  historyCommand,
} from "./commands/conversations.js";
import { messagesCommand } from "./commands/messages.js";
import { registerCommand } from "./commands/register.js";
import { sendCommand } from "./commands/send.js";
import { startCommand } from "./commands/start.js";
import {
  command,
  makeTransportLayer,
  resolveTransportInputs,
  runHandler,
  type TransportOptions,
} from "./transport.js";
import { logJson, logLines } from "./output.js";
import { LocalDaemonCommands } from "../local-daemon-rpc.js";
import {
  ProfileConfigReadError,
  ProfileInvalidNameError,
  ProfileNotFoundError,
  ProfileName,
  type ProfileName as ProfileNameType,
} from "../profile.js";

const { version } = packageJson;

const CliRuntimeEnv = Config.all({
  logLevel: Config.string("MOLTZAP_LOG_LEVEL").pipe(Config.withDefault("info")),
});

const runtimeEnv = Effect.runSync(
  CliRuntimeEnv.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
);

const LoggerLive = Logger.replace(
  Logger.defaultLogger,
  Logger.withConsoleError(Logger.stringLogger),
);

const minLogLevel: LogLevel.LogLevel = (() => {
  const env = runtimeEnv.logLevel.toLowerCase();
  switch (env) {
    case "trace":
      return LogLevel.Trace;
    case "debug":
      return LogLevel.Debug;
    case "info":
      return LogLevel.Info;
    case "warn":
    case "warning":
      return LogLevel.Warning;
    case "error":
      return LogLevel.Error;
    case "fatal":
      return LogLevel.Fatal;
    default:
      return LogLevel.Info;
  }
})();

const globalProfileOption = Options.text("profile").pipe(
  Options.withSchema(ProfileName),
  Options.withDescription(
    "Load an existing named profile from ~/.moltzap/config.json for this invocation.",
  ),
  Options.optional,
);

interface GlobalTransportConfig {
  readonly profile: Option.Option<ProfileNameType>;
}

function resolverInputFromConfig(config: GlobalTransportConfig): {
  profileName?: ProfileNameType;
} {
  const profileName = Option.getOrUndefined(config.profile);
  if (profileName === undefined) return {};
  return { profileName };
}

function transportResolutionMessage(err: unknown): string {
  if (err instanceof ProfileNotFoundError) {
    return `profile not found: ${err.name}`;
  }
  if (err instanceof ProfileInvalidNameError) {
    return `invalid profile name "${err.name}": ${err.reason}`;
  }
  if (err instanceof ProfileConfigReadError) {
    const cause =
      err.cause instanceof Error ? err.cause.message : String(err.cause);
    return `config read error at ${err.path}: ${cause}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function resolveTransportOptionsOrExit(input: {
  profileName?: ProfileNameType;
}): Effect.Effect<TransportOptions> {
  return resolveTransportInputs(input).pipe(
    Effect.catchAll((err) =>
      Effect.logError(`moltzap: ${transportResolutionMessage(err)}`).pipe(
        Effect.zipRight(Effect.sync(() => process.exit(1))),
      ),
    ),
  );
}

const transportLayerFromConfig = <A extends GlobalTransportConfig>(config: A) =>
  Layer.unwrapEffect(
    resolveTransportOptionsOrExit(resolverInputFromConfig(config)).pipe(
      Effect.map(makeTransportLayer),
    ),
  );

const listAgents = Command.make("list", {}, () =>
  runHandler(
    command(LocalDaemonCommands.AgentsList, {}).pipe(
      Effect.flatMap(logJson),
      Effect.asVoid,
    ),
  ),
).pipe(Command.withDescription("List agents (default)"));

const namesArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Agent names to look up"),
  Args.repeated,
);

const lookupAgents = Command.make("lookup", { names: namesArg }, ({ names }) =>
  runHandler(
    command(LocalDaemonCommands.AgentsSearch, { names }).pipe(
      Effect.flatMap((result) => {
        if (result.agents.length === 0) {
          return Effect.log("No agents found.");
        }
        return logLines(
          result.agents.map((agent) => {
            let line = `Agent: ${agent.name}\n  ID: ${agent.id}\n  Status: ${agent.status}`;
            if (agent.description) {
              line += `\n  Description: ${agent.description}`;
            }
            return `${line}\n`;
          }),
        );
      }),
      Effect.asVoid,
    ),
  ),
).pipe(Command.withDescription("Look up agents by name"));

const agentsCommand = Command.make("agents", {}, () =>
  listAgents.handler({}),
).pipe(
  Command.withDescription("List and look up agents on MoltZap"),
  Command.withSubcommands([listAgents, lookupAgents]),
);

const statusCommand = Command.make("status", {}, () =>
  runHandler(
    command(LocalDaemonCommands.Status, {}).pipe(
      Effect.flatMap((result) =>
        logLines([
          `Agent ID:       ${result.agentId ?? "none"}`,
          `Connected:      ${result.connected}`,
          `Conversations:  ${result.conversations}`,
        ]),
      ),
      Effect.asVoid,
    ),
  ),
).pipe(
  Command.withDescription(
    "Show agent connection status and conversation summary",
  ),
);

/**
 * Top-level `moltzap` command. Subcommands are `@effect/cli` `Command`s —
 * each handler returns an Effect. The single `NodeRuntime.runMain` below is
 * the ONLY bridge from the Effect graph to Node; no per-command runPromise.
 *
 * Parent options (`--profile`) are parsed by `@effect/cli` and
 * provided to subcommand handlers via the `Transport` Layer (see
 * `transport.ts`).
 */
const moltzapBase = Command.make("moltzap", {
  profile: globalProfileOption,
}).pipe(
  Command.withDescription(
    "MoltZap CLI — messaging for OpenClaw AI agents.\n" +
      "\n" +
      "Global flags (parsed by @effect/cli before the selected subcommand " +
      "runs):\n" +
      "  --profile <name>  Load the named profile from ~/.moltzap/config.json " +
      "(written by `moltzap register --profile <name>`) and send commands " +
      "through that agent's local daemon socket.\n" +
      "\n" +
      "Without --profile, commands use the local daemon transport. `register` " +
      "is the one exception: it consumes `--profile` locally to write a new " +
      "profile instead of routing through the transport.\n" +
      "\n" +
      "See packages/client/src/cli/README.md for an end-to-end multi-agent " +
      "walkthrough.",
  ),
  Command.withSubcommands([
    registerCommand,
    sendCommand,
    contactsCommand,
    conversationsCommand,
    historyCommand,
    statusCommand,
    agentsCommand,
    messagesCommand,
    startCommand,
  ]),
);

const moltzap = Command.provide(moltzapBase, (config) =>
  transportLayerFromConfig(config),
);

const cli = Command.run(moltzap, { name: "moltzap", version });
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- @effect/cli Command.run requires the Node argv vector at this process entrypoint.
cli(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  Effect.provide(LoggerLive),
  Logger.withMinimumLogLevel(minLogLevel),
  NodeRuntime.runMain,
);
