#!/usr/bin/env node
/** @file MoltZap CLI entrypoint and global transport option wiring. */
import { Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger, Option } from "effect";
import packageJson from "../../package.json" with { type: "json" };
import { agentsCommand } from "./commands/agents.js";
import { contactsCommand } from "./commands/contacts.js";
import {
  conversationsCommand,
  historyCommand,
} from "./commands/conversations.js";
import { messagesCommand } from "./commands/messages.js";
import { registerCommand } from "./commands/register.js";
import { sendCommand } from "./commands/send.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { LoggerLive, minLogLevel } from "./runtime.js";
import {
  makeTransportLayer,
  resolveTransportInputs,
  TransportConfigError,
  type TransportOptions,
} from "./transport.js";
import {
  ProfileConfigReadError,
  ProfileInvalidNameError,
  ProfileNotFoundError,
} from "../profile.js";
import { currentArgv } from "./process-argv.js";

const { version } = packageJson;

const globalProfileOption = Options.text("profile").pipe(
  Options.withDescription(
    "Load an existing named profile from ~/.moltzap/config.json for this invocation.",
  ),
  Options.optional,
);

interface GlobalTransportConfig {
  readonly profile: Option.Option<string>;
}

function resolverInputFromConfig(config: GlobalTransportConfig): {
  profileName?: string;
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
  if (err instanceof TransportConfigError) {
    return `transport config: ${err.reason}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function resolveTransportOptionsOrExit(input: {
  profileName?: string;
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
cli(currentArgv()).pipe(
  Effect.provide(NodeContext.layer),
  Effect.provide(LoggerLive),
  Logger.withMinimumLogLevel(minLogLevel),
  NodeRuntime.runMain,
);
