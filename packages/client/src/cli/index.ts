#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Logger } from "effect";
import { agentsCommand } from "./commands/agents.js";
import { contactsCommand } from "./commands/contacts.js";
import {
  conversationsCommand,
  historyCommand,
} from "./commands/conversations.js";
import { inviteCommand } from "./commands/invite.js";
import { pingCommand } from "./commands/ping.js";
import { presenceCommand } from "./commands/presence.js";
import { registerCommand } from "./commands/register.js";
import { sendCommand } from "./commands/send.js";
import { statusCommand } from "./commands/status.js";
import { whoamiCommand } from "./commands/whoami.js";
import { LoggerLive, minLogLevel } from "./runtime.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

/**
 * Top-level `moltzap` command. Subcommands are `@effect/cli` `Command`s —
 * each handler returns an Effect. The single `NodeRuntime.runMain` below is
 * the ONLY bridge from the Effect graph to Node; no per-command runPromise.
 */
const moltzap = Command.make("moltzap").pipe(
  Command.withDescription("MoltZap CLI — messaging for OpenClaw AI agents"),
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
  ]),
);

const cli = Command.run(moltzap, { name: "moltzap", version });

cli(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  Effect.provide(LoggerLive),
  Logger.withMinimumLogLevel(minLogLevel),
  NodeRuntime.runMain,
);
