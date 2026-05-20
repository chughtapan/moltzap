import { Args, Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Either, Option } from "effect";
import {
  getOpenClawConfigDir,
  getOpenClawConfigPath,
} from "../../local-paths.js";
import { getServerUrl, updateConfig } from "../config.js";
import { registerAgent } from "../http-client.js";
import {
  emitNoPersist,
  parseProfileName,
  writeProfile,
  type ProfileRecord,
} from "../profile.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const JSON_INDENT_SPACES = 2;

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

function parseOpenClawConfig(
  contents: string,
): Effect.Effect<OpenClawConfig, unknown> {
  return Effect.try({
    try: () => JSON.parse(contents) as OpenClawConfig,
    catch: (err) => err,
  });
}

function readExistingOpenClawConfig(
  fileSystem: FileSystem.FileSystem,
  configPath: string,
): Effect.Effect<OpenClawConfig, unknown> {
  return fileSystem.exists(configPath).pipe(
    Effect.flatMap((exists) => {
      if (!exists) return Effect.succeed<OpenClawConfig>({});
      return fileSystem
        .readFileString(configPath, "utf-8")
        .pipe(Effect.flatMap(parseOpenClawConfig));
    }),
  );
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
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = getOpenClawConfigDir();
    const configPath = getOpenClawConfigPath();

    let config: OpenClawConfig = {};
    const existingConfig = yield* readExistingOpenClawConfig(
      fileSystem,
      configPath,
    ).pipe(Effect.either);
    yield* Either.match(existingConfig, {
      onLeft: (err) =>
        Effect.logWarning(
          `moltzap: existing openclaw.json unreadable, starting fresh: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      onRight: (value) =>
        Effect.sync(() => {
          config = value;
        }),
    });

    const channels = config.channels ?? {};
    channels.moltzap = {
      accounts: [{ id: "default", ...account }],
    };
    config.channels = channels;

    yield* fileSystem.makeDirectory(configDir, { recursive: true });
    yield* fileSystem.writeFileString(
      configPath,
      JSON.stringify(config, null, JSON_INDENT_SPACES) + "\n",
    );
  }).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (err) =>
          Effect.fail(err instanceof Error ? err : new Error(String(err))),
        onRight: (value) => Effect.succeed(value),
      }),
    ),
  );

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
//
// NOTE on `--profile` routing: `register` consumes `--profile` locally because
// it writes a NEW profile. Parent-level `moltzap --profile <name>` still means
// "load an existing profile" for transport selection, and would reject the new
// profile before this command could create it.
const profileOption = Options.text("profile").pipe(
  Options.withDescription(
    "Named profile to register under. Writes the new apiKey to " +
      "`profiles.<name>` in ~/.moltzap/config.json. Omit to overwrite the " +
      "legacy top-level record (the default profile). Other subcommands " +
      "select an existing profile via the global `--profile` flag (see " +
      "`moltzap --help`).",
  ),
  Options.optional,
);

const noPersistFlag = Options.boolean("no-persist").pipe(
  Options.withDescription(
    "Do not write the registered key to ~/.moltzap/config.json or " +
      "~/.openclaw/openclaw.json. Prints the apiKey and claim URL to stdout " +
      "so the caller can capture them (e.g. into an env var for use with " +
      "`--as $KEY`) without mutating either config tree.",
  ),
);

type RegistrationResult = Effect.Effect.Success<
  ReturnType<typeof registerAgent>
>;
type NoPersistEmission = Effect.Effect.Success<
  ReturnType<typeof emitNoPersist>
>;

interface PersistRegistrationInput {
  readonly profile: Option.Option<string>;
  readonly record: ProfileRecord;
  readonly result: RegistrationResult;
  readonly serverUrl: string;
  readonly name: string;
}

function invalidAgentName(name: string): Effect.Effect<never> {
  return Effect.sync(() => {
    console.error(
      `Invalid agent name "${name}". Must be 3-32 chars, lowercase alphanumeric and hyphens, cannot start or end with a hyphen.`,
    );
    process.exit(1);
  });
}

function profileRecordFrom(
  name: string,
  result: RegistrationResult,
  serverUrl: string,
): ProfileRecord {
  return {
    apiKey: result.apiKey,
    agentName: name,
    serverUrl,
    registeredAt: new Date().toISOString(),
  };
}

function printNoPersistRegistration(
  name: string,
  result: RegistrationResult,
  emitted: NoPersistEmission,
): void {
  console.log(`Agent "${name}" registered (not persisted).`);
  console.log(`  Agent ID:   ${result.agentId}`);
  console.log(`  API Key:    ${emitted.record.apiKey}`);
  console.log(`  Server URL: ${emitted.record.serverUrl}`);
  console.log(`  Claim URL:  ${result.claimUrl}`);
  console.log(
    "\nShare the claim URL with the agent's owner to verify ownership.",
  );
}

function printPersistedRegistration(
  name: string,
  result: RegistrationResult,
  serverUrl: string,
): void {
  console.log(`Agent "${name}" registered and channel configured.`);
  console.log(`  Agent ID:   ${result.agentId}`);
  console.log(`  API Key:    ${result.apiKey}`);
  console.log(`  Server URL: ${serverUrl}`);
  console.log(`  Claim URL:  ${result.claimUrl}`);
  console.log(
    "\nShare the claim URL with the agent's owner to verify ownership.",
  );
}

function persistRegistration({
  profile,
  record,
  result,
  serverUrl,
  name,
}: PersistRegistrationInput): Effect.Effect<void, unknown> {
  if (Option.isSome(profile)) {
    return parseProfileName(profile.value).pipe(
      Effect.flatMap((profileName) => writeProfile(profileName, record)),
    );
  }
  return updateConfig(() => ({
    serverUrl,
    apiKey: result.apiKey,
    agentName: name,
  })).pipe(
    Effect.zipRight(
      writeOpenClawChannelConfig({
        apiKey: result.apiKey,
        serverUrl,
        agentName: name,
      }),
    ),
  );
}

/**
 * `moltzap register &lt;name> &lt;invite-code> [-d description] [--profile &lt;name>] [--no-persist]`
 *
 * POST /api/v1/auth/register, then (by default) persist the result into
 * both `~/.moltzap/config.json` and the OpenClaw channel config so the
 * channel picks it up on its next file-watcher cycle.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant shell
 *   participant cli as effect-cli
 *   participant reg as registerCommand
 *   participant http as registerAgent
 *   participant server
 *   participant fs
 *
 *   shell->>cli: moltzap register &lt;name> &lt;code>
 *   Note over cli: parse args + NAME_PATTERN test&lt;br>fail → console.error + process.exit(1)
 *   cli->>reg: handler({name, inviteCode, ...})
 *   reg->>http: registerAgent(name, inviteCode, desc)
 *   http->>server: POST /api/v1/auth/register
 *   server-->>http: 200 {agentId, apiKey, claimUrl}
 *   http-->>reg: RegisterResponse
 *   alt --no-persist
 *     reg-->>shell: stdout — print response
 *   else default
 *     reg->>fs: persistRegistration&lt;br>profile? writeProfile : updateConfig&lt;br>+ writeOpenClawChannelConfig
 *     reg-->>shell: stdout — Agent registered
 *   end
 * ```
 *
 * Options:
 *   --profile &lt;name>  write under `profiles.&lt;name>` instead of the
 *                     legacy top-level keys.
 *   --no-persist      print to stdout only; no writes to either
 *                     `~/.moltzap/config.json` or
 *                     `~/.openclaw/openclaw.json`.
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
      return invalidAgentName(name);
    }
    const desc = Option.isSome(description) ? description.value : undefined;
    return Effect.gen(function* () {
      const result = yield* registerAgent(name, inviteCode, desc);
      const serverUrl = yield* getServerUrl;
      const record = profileRecordFrom(name, result, serverUrl);

      if (noPersist) {
        // Invariant §4.4: no writes to ~/.moltzap/ or ~/.openclaw/.
        const emitted = yield* emitNoPersist(record);
        printNoPersistRegistration(name, result, emitted);
        return;
      }

      yield* persistRegistration({ profile, record, result, serverUrl, name });
      printPersistedRegistration(name, result, serverUrl);
    }).pipe(
      Effect.withSpan("registerCommand"),
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
