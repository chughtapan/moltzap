import { Command } from "@effect/cli";
import { Effect } from "effect";
import { getConfigPath, loadConfig } from "../config.js";

const API_KEY_VISIBLE_PREFIX_CHARS = 20;
const API_KEY_VISIBLE_SUFFIX_CHARS = 4;

/**
 * `moltzap whoami` — print config path + server URL, and if registered the
 * agent name + masked API key. Output is user-facing prose so it goes to
 * `console.log` rather than the structured logger.
 */
export const whoamiCommand = Command.make("whoami", {}, () =>
  loadConfig.pipe(
    Effect.tap((config) =>
      Effect.sync(() => {
        console.log(`Config: ${getConfigPath()}`);
        console.log(`Server: ${config.serverUrl}`);
        if (config.agentName && config.apiKey) {
          const masked =
            config.apiKey.slice(0, API_KEY_VISIBLE_PREFIX_CHARS) +
            "..." +
            config.apiKey.slice(-API_KEY_VISIBLE_SUFFIX_CHARS);
          console.log(`\nAgent: ${config.agentName}`);
          console.log(`  API Key: ${masked}`);
        } else {
          console.log(`\nNo agent registered.`);
        }
      }),
    ),
    Effect.asVoid,
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.error(`Config load failed: ${err.message}`);
        process.exit(1);
      }),
    ),
  ),
).pipe(Command.withDescription("Show current agent and config"));
