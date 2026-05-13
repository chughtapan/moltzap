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

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

interface ExtractedGlobalFlags {
  impersonateKey?: string;
  profileName?: string;
  rest: Array<string>;
}

interface ParsedFlag {
  readonly matched: boolean;
  readonly value?: string;
  readonly nextIndex: number;
}

function isRegisterCommand(argv: ReadonlyArray<string>): boolean {
  return argv.some(
    (token, index) =>
      token === "register" &&
      argv.slice(0, index).every((prev) => !prev.startsWith("-")),
  );
}

function parseGlobalFlag(
  argv: ReadonlyArray<string>,
  index: number,
  flagName: string,
): ParsedFlag {
  const token = argv[index]!;
  if (token === flagName) {
    const value = argv[index + 1];
    return value === undefined
      ? { matched: true, nextIndex: index }
      : { matched: true, value, nextIndex: index + 1 };
  }
  const prefix = `${flagName}=`;
  if (token.startsWith(prefix)) {
    return {
      matched: true,
      value: token.slice(prefix.length),
      nextIndex: index,
    };
  }
  return { matched: false, nextIndex: index };
}

/**
 * Pull `--as &lt;key>` and `--profile &lt;name>` out of argv before handing the
 * remainder to `@effect/cli`. These are semantically global flags that
 * shape the transport layer for the whole invocation (spec sbd#177 rev 3
 * §5.1, §5.2, Invariant §4.2). Pre-parsing keeps the `@effect/cli` subcommand
 * tree clean of duplicated global options and guarantees `--as` can short-
 * circuit config-read side effects (architect design doc rev 4 finding 1).
 *
 * Accepts both `--as KEY` / `--as=KEY` forms; unknown flags pass through
 * to `@effect/cli` unchanged.
 */
export const extractGlobalFlags = (
  argv: ReadonlyArray<string>,
): ExtractedGlobalFlags => {
  // register parses --profile locally (spec §5.2: it writes a NEW profile).
  // Intercepting at global scope would make the transport-resolver treat a
  // not-yet-created profile as a lookup failure. Route --profile to register
  // when register is the invoked subcommand; route globally otherwise.
  const isRegister = isRegisterCommand(argv);

  const rest: Array<string> = [];
  let impersonateKey: string | undefined;
  let profileName: string | undefined;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    const asFlag = parseGlobalFlag(argv, index, "--as");
    if (asFlag.matched) {
      impersonateKey = asFlag.value;
      index = asFlag.nextIndex + 1;
      continue;
    }
    if (!isRegister) {
      const profileFlag = parseGlobalFlag(argv, index, "--profile");
      if (profileFlag.matched) {
        profileName = profileFlag.value;
        index = profileFlag.nextIndex + 1;
        continue;
      }
    }
    rest.push(token);
    index += 1;
  }
  const out: ExtractedGlobalFlags = { rest };
  if (impersonateKey !== undefined) out.impersonateKey = impersonateKey;
  if (profileName !== undefined) out.profileName = profileName;
  return out;
};

/**
 * Top-level `moltzap` command. Subcommands are `@effect/cli` `Command`s —
 * each handler returns an Effect. The single `NodeRuntime.runMain` below is
 * the ONLY bridge from the Effect graph to Node; no per-command runPromise.
 *
 * Global flags (`--as`, `--profile`) are pre-parsed from argv in
 * `extractGlobalFlags` above and provided to subcommand handlers via the
 * `Transport` Layer (see `transport.ts`).
 */
const moltzap = Command.make("moltzap").pipe(
  Command.withDescription(
    "MoltZap CLI — messaging for OpenClaw AI agents.\n" +
      "\n" +
      "Global flags (pre-parsed by the CLI before @effect/cli sees argv; " +
      "shared across every subcommand):\n" +
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

const cli = Command.run(moltzap, { name: "moltzap", version });
const NODE_ARGV_USER_ARGS_OFFSET = 2;

const processArgv = currentArgv();
const { impersonateKey, profileName, rest } = extractGlobalFlags(
  processArgv.slice(NODE_ARGV_USER_ARGS_OFFSET),
);

const resolverInput: { impersonateKey?: string; profileName?: string } = {};
if (impersonateKey !== undefined) resolverInput.impersonateKey = impersonateKey;
if (profileName !== undefined) resolverInput.profileName = profileName;

// Resolve transport inputs eagerly. On failure exit with a user-readable
// message before touching @effect/cli; the CLI parser never sees a broken
// transport config.
const transportOptions: TransportOptions = (() => {
  const exit1 = (msg: string): never => {
    console.error(`moltzap: ${msg}`);
    process.exit(1);
  };
  try {
    return Effect.runSync(resolveTransportInputs(resolverInput));
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      return exit1(`profile not found: ${err.name}`);
    }
    if (err instanceof ProfileInvalidNameError) {
      return exit1(`invalid profile name "${err.name}": ${err.reason}`);
    }
    if (err instanceof ProfileConfigReadError) {
      const cause =
        err.cause instanceof Error ? err.cause.message : String(err.cause);
      return exit1(`config read error at ${err.path}: ${cause}`);
    }
    if (err instanceof TransportConfigError) {
      return exit1(`transport config: ${err.reason}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return exit1(msg);
  }
})();

const TransportLive = makeTransportLayer(transportOptions);

// Re-assemble argv so @effect/cli sees the same process-shape it expects
// (Command.run slices off the first two tokens).
const argvForCli = [
  processArgv[0] ?? "node",
  processArgv[1] ?? "moltzap",
  ...rest,
];

cli(argvForCli).pipe(
  Effect.provide(TransportLive),
  Effect.provide(NodeContext.layer),
  Effect.provide(LoggerLive),
  Logger.withMinimumLogLevel(minLogLevel),
  NodeRuntime.runMain,
);
