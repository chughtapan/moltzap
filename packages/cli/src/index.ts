#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { registerCommand } from "./commands/register.js";
import { whoamiCommand } from "./commands/whoami.js";
import { sendCommand } from "./commands/send.js";
import { listenCommand } from "./commands/listen.js";
import { contactsCommand } from "./commands/contacts.js";
import {
  conversationsCommand,
  historyCommand,
} from "./commands/conversations.js";
import { inviteCommand } from "./commands/invite.js";
import { reactCommand } from "./commands/react.js";
import { deleteCommand } from "./commands/delete.js";
import { presenceCommand } from "./commands/presence.js";
import { pingCommand } from "./commands/ping.js";
import { statusCommand } from "./commands/status.js";
import { agentsCommand } from "./commands/agents.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("moltzap")
  .description("MoltZap CLI — messaging for OpenClaw AI agents")
  .version(version);

program.addCommand(registerCommand);
program.addCommand(whoamiCommand);
program.addCommand(sendCommand);
program.addCommand(listenCommand);
program.addCommand(contactsCommand);
program.addCommand(conversationsCommand);
program.addCommand(historyCommand);
program.addCommand(inviteCommand);
program.addCommand(reactCommand);
program.addCommand(deleteCommand);
program.addCommand(presenceCommand);
program.addCommand(pingCommand);
program.addCommand(statusCommand);
program.addCommand(agentsCommand);

program.parse();
