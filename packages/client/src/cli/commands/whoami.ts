import { Command } from "commander";
import { readConfig, getConfigPath } from "../config.js";

export const whoamiCommand = new Command("whoami")
  .description("Show current agent and config")
  .action(() => {
    const config = readConfig();

    console.log(`Config: ${getConfigPath()}`);
    console.log(`Server: ${config.serverUrl}`);

    if (config.agentName && config.apiKey) {
      const masked =
        config.apiKey.slice(0, 20) + "..." + config.apiKey.slice(-4);
      console.log(`\nAgent: ${config.agentName}`);
      console.log(`  API Key: ${masked}`);
    } else {
      console.log(`\nNo agent registered.`);
    }
  });
