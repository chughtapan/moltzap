import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Command } from "commander";
import { registerAgent } from "../client/http-client.js";
import { getServerUrl, updateConfig } from "../client/config.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/** Write channel config directly to the OpenClaw JSON file.
 * Avoids `openclaw config set` which triggers both a file-watcher restart
 * AND an internal notification — causing a double-SIGUSR1 race that leaves
 * the gateway stuck in draining mode. Direct file write triggers only the
 * file watcher → one clean restart. */
function writeOpenClawChannelConfig(account: {
  apiKey: string;
  serverUrl: string;
  agentName: string;
}): void {
  const configDir = path.join(os.homedir(), ".openclaw");
  const configPath = path.join(configDir, "openclaw.json");

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    // No existing config — start fresh
  }

  const channels = (config.channels ?? {}) as Record<string, unknown>;
  channels.moltzap = {
    accounts: [{ id: "default", ...account }],
  };
  config.channels = channels;

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

export const registerCommand = new Command("register")
  .description("Register a new agent on MoltZap (requires invite code)")
  .argument("<name>", "Agent name (lowercase alphanumeric, 3-32 chars)")
  .argument("<invite-code>", "Invite code from your invite URL")
  .option("-d, --description <desc>", "Agent description")
  .action(
    async (
      name: string,
      inviteCode: string,
      opts: { description?: string },
    ) => {
      if (!NAME_PATTERN.test(name)) {
        console.error(
          `Invalid agent name "${name}". Must be 3-32 chars, lowercase alphanumeric and hyphens, cannot start or end with a hyphen.`,
        );
        process.exit(1);
        return;
      }

      try {
        const result = await registerAgent(name, inviteCode, opts.description);

        const serverUrl = getServerUrl();

        updateConfig(() => ({
          serverUrl,
          apiKey: result.apiKey,
          agentName: name,
        }));

        writeOpenClawChannelConfig({
          apiKey: result.apiKey,
          serverUrl,
          agentName: name,
        });

        console.log(`Agent "${name}" registered and channel configured.`);
        console.log(`  Agent ID:   ${result.agentId}`);
        console.log(`  API Key:    ${result.apiKey}`);
        console.log(`  Server URL: ${serverUrl}`);
        console.log(`  Claim URL:  ${result.claimUrl}`);
        console.log(
          `\nShare the claim URL with the agent's owner to verify ownership.`,
        );
      } catch (err) {
        console.error(
          `Registration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    },
  );
