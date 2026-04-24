#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Logger } from "effect";
import { agentsCommand } from "./commands/agents.js";
import { appsCommand } from "./commands/apps.js";
import { contactsCommand } from "./commands/contacts.js";
import {
  conversationsCommand,
  historyCommand,
} from "./commands/conversations.js";
import { inviteCommand } from "./commands/invite.js";
import { messagesCommand } from "./commands/messages.js";
import { permissionsCommand } from "./commands/permissions.js";
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

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

/**
 * Pull `--as <key>` and `--profile <name>` out of argv before handing the
 * remainder to `@effect/cli`. These are semantically global flags that
 * shape the transport layer for the whole invocation (spec sbd#177 rev 3
 * §5.1, §5.2, Invariant §4.2). Pre-parsing keeps the @effect/cli subcommand
 * tree clean of duplicated global options and guarantees `--as` can short-
 * circuit config-read side effects (architect design doc rev 4 finding 1).
 *
 * Accepts both `--as KEY` / `--as=KEY` forms; unknown flags pass through
 * to @effect/cli unchanged.
 */
export const extractGlobalFlags = (
  argv: ReadonlyArray<string>,
): {
  impersonateKey?: string;
  profileName?: string;
  rest: Array<string>;
} => {
  // register parses --profile locally (spec §5.2: it writes a NEW profile).
  // Intercepting at global scope would make the transport-resolver treat a
  // not-yet-created profile as a lookup failure. Route --profile to register
  // when register is the invoked subcommand; route globally otherwise.
  const isRegister = argv.some(
    (t, i) =>
      t === "register" &&
      argv.slice(0, i).every((prev) => !prev.startsWith("-")),
  );

  const rest: Array<string> = [];
  let impersonateKey: string | undefined;
  let profileName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--as") {
      const next = argv[i + 1];
      if (next !== undefined) {
        impersonateKey = next;
        i++;
      }
      continue;
    }
    if (token.startsWith("--as=")) {
      impersonateKey = token.slice("--as=".length);
      continue;
    }
    if (!isRegister) {
      if (token === "--profile") {
        const next = argv[i + 1];
        if (next !== undefined) {
          profileName = next;
          i++;
        }
        continue;
      }
      if (token.startsWith("--profile=")) {
        profileName = token.slice("--profile=".length);
        continue;
      }
    }
    rest.push(token);
  }
  const out: {
    impersonateKey?: string;
    profileName?: string;
    rest: Array<string>;
  } = { rest };
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
    appsCommand,
    permissionsCommand,
    messagesCommand,
  ]),
);

const cli = Command.run(moltzap, { name: "moltzap", version });

const { impersonateKey, profileName, rest } = extractGlobalFlags(
  process.argv.slice(2),
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
  process.argv[0] ?? "node",
  process.argv[1] ?? "moltzap",
  ...rest,
];

cli(argvForCli).pipe(
  Effect.provide(TransportLive),
  Effect.provide(NodeContext.layer),
  Effect.provide(LoggerLive),
  Logger.withMinimumLogLevel(minLogLevel),
  NodeRuntime.runMain,
);
