import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { getServerUrl, updateConfig } from "../config.js";
import { registerAgent } from "../http-client.js";
import {
  emitNoPersist,
  parseProfileName,
  writeProfile,
  type ProfileRecord,
} from "../profile.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

interface OpenClawConfig {
  channels?: {
    moltzap?: {
      accounts: Array<{
        id: string;
        apiKey: string;
        serverUrl: string;
        agentName: string;
      }>;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Write channel config directly to the OpenClaw JSON file.
 * Avoids `openclaw config set` which triggers both a file-watcher restart
 * AND an internal notification — causing a double-SIGUSR1 race that leaves
 * the gateway stuck in draining mode. Direct file write triggers only the
 * file watcher → one clean restart.
 *
 * Per architect design rev 4 finding 2, this side effect is gated by the
 * caller: `--no-persist` skips this call entirely (Invariant §4.4).
 */
const writeOpenClawChannelConfig = (account: {
  apiKey: string;
  serverUrl: string;
  agentName: string;
}): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      const configDir = path.join(os.homedir(), ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");

      let config: OpenClawConfig = {};
      try {
        config = JSON.parse(
          fs.readFileSync(configPath, "utf-8"),
        ) as OpenClawConfig;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          console.warn(
            `moltzap: existing openclaw.json unreadable, starting fresh: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      const channels = config.channels ?? {};
      channels.moltzap = {
        accounts: [{ id: "default", ...account }],
      };
      config.channels = channels;

      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    },
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });

const nameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Agent name (lowercase alphanumeric, 3-32 chars)"),
);

const inviteCodeArg = Args.text({ name: "invite-code" }).pipe(
  Args.withDescription("Invite code from your invite URL"),
);

const descriptionOption = Options.text("description").pipe(
  Options.withAlias("d"),
  Options.withDescription("Agent description"),
  Options.optional,
);

// Spec sbd#177 rev 3 §5.2 barrel edits: --profile and --no-persist.
const profileOption = Options.text("profile").pipe(
  Options.withDescription(
    "Named profile to register under (default: legacy top-level record)",
  ),
  Options.optional,
);

const noPersistFlag = Options.boolean("no-persist").pipe(
  Options.withDescription(
    "Do not write the registered key to ~/.moltzap/ or ~/.openclaw/",
  ),
);

/**
 * `moltzap register <name> <invite-code> [-d description] [--profile <name>] [--no-persist]`
 *
 * POST /api/v1/auth/register, then (by default) persist the result into
 * both `~/.moltzap/config.json` and the OpenClaw channel config so the
 * channel picks it up on its next file-watcher cycle.
 *
 * Spec §5.2 extensions:
 *   --profile <name>  write under `profiles.<name>` instead of legacy top-level
 *   --no-persist      print result to stdout only; NO writes to either tree
 *
 * `--no-persist` gates BOTH the `~/.moltzap/config.json` write AND the
 * `~/.openclaw/openclaw.json` write (Invariant §4.4 as revised in architect
 * design doc rev 4 finding 2).
 */
export const registerCommand = Command.make(
  "register",
  {
    name: nameArg,
    inviteCode: inviteCodeArg,
    description: descriptionOption,
    profile: profileOption,
    noPersist: noPersistFlag,
  },
  ({ name, inviteCode, description, profile, noPersist }) => {
    if (!NAME_PATTERN.test(name)) {
      return Effect.sync(() => {
        console.error(
          `Invalid agent name "${name}". Must be 3-32 chars, lowercase alphanumeric and hyphens, cannot start or end with a hyphen.`,
        );
        process.exit(1);
      });
    }
    const desc = Option.isSome(description) ? description.value : undefined;
    return Effect.gen(function* () {
      const result = yield* registerAgent(name, inviteCode, desc);
      const serverUrl = yield* getServerUrl;

      const record: ProfileRecord = {
        apiKey: result.apiKey,
        agentName: name,
        serverUrl,
        registeredAt: new Date().toISOString(),
      };

      if (noPersist) {
        // Invariant §4.4: no writes to ~/.moltzap/ or ~/.openclaw/.
        const emitted = yield* emitNoPersist(record);
        console.log(`Agent "${name}" registered (not persisted).`);
        console.log(`  Agent ID:   ${result.agentId}`);
        console.log(`  API Key:    ${emitted.record.apiKey}`);
        console.log(`  Server URL: ${emitted.record.serverUrl}`);
        console.log(`  Claim URL:  ${result.claimUrl}`);
        console.log(
          `\nShare the claim URL with the agent's owner to verify ownership.`,
        );
        return;
      }

      if (Option.isSome(profile)) {
        const profileName = yield* parseProfileName(profile.value);
        yield* writeProfile(profileName, record);
      } else {
        // Legacy top-level persistence path (unchanged).
        yield* updateConfig(() => ({
          serverUrl,
          apiKey: result.apiKey,
          agentName: name,
        }));

        yield* writeOpenClawChannelConfig({
          apiKey: result.apiKey,
          serverUrl,
          agentName: name,
        });
      }

      console.log(`Agent "${name}" registered and channel configured.`);
      console.log(`  Agent ID:   ${result.agentId}`);
      console.log(`  API Key:    ${result.apiKey}`);
      console.log(`  Server URL: ${serverUrl}`);
      console.log(`  Claim URL:  ${result.claimUrl}`);
      console.log(
        `\nShare the claim URL with the agent's owner to verify ownership.`,
      );
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Registration failed: ${msg}`);
          process.exit(1);
        }),
      ),
    );
  },
).pipe(
  Command.withDescription(
    "Register a new agent on MoltZap (requires invite code)",
  ),
);
