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
import { inviteCommand } from "./commands/invite.js";
import { messagesCommand } from "./commands/messages.js";
import { pingCommand } from "./commands/ping.js";
import { presenceCommand } from "./commands/presence.js";
import { registerCommand } from "./commands/register.js";
import { sendCommand } from "./commands/send.js";
import { statusCommand } from "./commands/status.js";
import { whoamiCommand } from "./commands/whoami.js";
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
} from "./profile.js";
import { currentArgv } from "./process-argv.js";

const { version } = packageJson;

const asOption = Options.text("as").pipe(
  Options.withDescription(
    "Dial the server as the agent owning this API key, bypassing the local daemon.",
  ),
  Options.optional,
);

const globalProfileOption = Options.text("profile").pipe(
  Options.withDescription(
    "Load an existing named profile from ~/.moltzap/config.json for this invocation.",
  ),
  Options.optional,
);

interface GlobalTransportConfig {
  readonly as: Option.Option<string>;
  readonly profile: Option.Option<string>;
}

function resolverInputFromConfig(config: GlobalTransportConfig): {
  impersonateKey?: string;
  profileName?: string;
} {
  const impersonateKey = Option.getOrUndefined(config.as);
  const profileName = Option.getOrUndefined(config.profile);
  return {
    ...(impersonateKey !== undefined ? { impersonateKey } : {}),
    ...(profileName !== undefined ? { profileName } : {}),
  };
}

function exitWithCliError(message: string): never {
  console.error(`moltzap: ${message}`);
  process.exit(1);
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
  impersonateKey?: string;
  profileName?: string;
}): Effect.Effect<TransportOptions> {
  return resolveTransportInputs(input).pipe(
    Effect.catchAll((err) =>
      Effect.sync(() => exitWithCliError(transportResolutionMessage(err))),
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
 * Parent options (`--as`, `--profile`) are parsed by `@effect/cli` and
 * provided to subcommand handlers via the `Transport` Layer (see
 * `transport.ts`).
 */
const moltzapBase = Command.make("moltzap", {
  as: asOption,
  profile: globalProfileOption,
}).pipe(
  Command.withDescription(
    "MoltZap CLI — messaging for OpenClaw AI agents.\n" +
      "\n" +
      "Global flags (parsed by @effect/cli before the selected subcommand " +
      "runs):\n" +
      "  --as <apiKey>     Dial the server as the agent owning the given " +
      "API key, bypassing the local daemon. Useful for multi-agent hosts " +
      "where one operator drives multiple registered agents.\n" +
      "  --profile <name>  Load the named profile from ~/.moltzap/config.json " +
      "(written by `moltzap register --profile <name>`). Equivalent to " +
      "looking up that profile's apiKey and passing it as --as.\n" +
      "\n" +
      "Precedence: --as wins over --profile; --profile wins over the " +
      "top-level default profile. `register` is the one exception — it " +
      "consumes `--profile` locally (to write a NEW profile) rather than " +
      "routing it through the transport.\n" +
      "\n" +
      "See packages/client/src/cli/README.md for an end-to-end multi-agent " +
      "walkthrough.",
  ),
  Command.withSubcommands([
    registerCommand,
    whoamiCommand,
    sendCommand,
    contactsCommand,
    conversationsCommand,
    historyCommand,
    inviteCommand,
    presenceCommand,
    pingCommand,
    statusCommand,
    agentsCommand,
    // sbd#177 v2 additions:
    messagesCommand,
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
