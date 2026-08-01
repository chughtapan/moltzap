import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { getHttpUrl, getServerUrl } from "../../config.js";
import { registerAgent } from "../../auth.js";
import {
  emitNoPersist,
  ProfileName,
  type ProfileName as ProfileNameType,
  type ProfileRecord,
  writeProfile,
} from "../../profile.js";
import { logLines } from "../output.js";

const nameArg = Args.text({ name: "name" }).pipe(
  Args.withSchema(ProfileName),
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

// `register` consumes `--profile` locally because it writes a NEW profile.
// Parent-level `moltzap --profile <name>` means "load an existing profile"
// for transport selection, and would reject the new profile before this
// command could create it.
const profileOption = Options.text("profile").pipe(
  Options.withSchema(ProfileName),
  Options.withDescription(
    "Named profile to register under. Writes the new apiKey to " +
      "`profiles.<name>` in ~/.moltzap/config.json. Omit to use the " +
      "agent name as the profile name. Other subcommands " +
      "select an existing profile via the global `--profile` flag (see " +
      "`moltzap --help`).",
  ),
  Options.optional,
);

const noPersistFlag = Options.boolean("no-persist").pipe(
  Options.withDescription(
    "Do not write the registered key to ~/.moltzap/config.json. Prints the " +
      "agent id without mutating client config.",
  ),
);

type RegistrationResult = Effect.Effect.Success<
  ReturnType<typeof registerAgent>
>;

interface PersistRegistrationInput {
  readonly profile: Option.Option<ProfileNameType>;
  readonly record: ProfileRecord;
  readonly name: ProfileNameType;
}

function profileRecordFrom(
  name: ProfileNameType,
  result: RegistrationResult,
): ProfileRecord {
  return {
    agentId: result.agentId,
    apiKey: result.apiKey,
    agentName: name,
  };
}

function printRegistration(
  headline: string,
  result: RegistrationResult,
  serverUrl: string,
): Effect.Effect<void> {
  return logLines([
    headline,
    `  Agent ID:   ${result.agentId}`,
    `  Server URL: ${serverUrl}`,
  ]);
}

function persistRegistration({
  profile,
  record,
  name,
}: PersistRegistrationInput): Effect.Effect<void, unknown> {
  return writeProfile(
    Option.getOrElse(profile, () => name),
    record,
  );
}

/**
 * `moltzap register &lt;name> &lt;invite-code> [-d description] [--profile &lt;name>] [--no-persist]`
 *
 * POST /api/v1/auth/register, then (by default) persist the result into
 * `~/.moltzap/config.json`.
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
 *   Note over cli: parse args + shared profile-name schema
 *   cli->>reg: handler({name, inviteCode, ...})
 *   reg->>http: registerAgent(name, inviteCode, desc)
 *   http->>server: POST /api/v1/auth/register
 *   server-->>http: 200 {agentId, apiKey}
 *   http-->>reg: RegisterResponse
 *   alt --no-persist
 *     reg-->>shell: stdout — print response
 *   else default
 *     reg->>fs: persistRegistration; writeProfile
 *     reg-->>shell: stdout — Agent registered
 *   end
 * ```
 *
 * Options:
 *   --profile &lt;name>  write under `profiles.&lt;name>`; omitted uses
 *                     the agent name as the profile name.
 *   --no-persist      print non-secret registration details only; no writes to
 *                     `~/.moltzap/config.json`.
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
    const desc = Option.isSome(description) ? description.value : undefined;
    return Effect.gen(function* () {
      const httpUrl = yield* getHttpUrl;
      const result = yield* registerAgent(httpUrl, name, {
        inviteCode,
        ...(desc === undefined ? {} : { description: desc }),
      });
      const serverUrl = yield* getServerUrl;
      const record = profileRecordFrom(name, result);

      if (noPersist) {
        // No writes to ~/.moltzap/.
        yield* emitNoPersist(record);
        yield* printRegistration(
          `Agent "${name}" registered (not persisted).`,
          result,
          serverUrl,
        );
        return;
      }

      yield* persistRegistration({ profile, record, name });
      yield* printRegistration(
        `Agent "${name}" registered and profile saved.`,
        result,
        serverUrl,
      );
    }).pipe(
      Effect.withSpan("registerCommand"),
      Effect.catchAll((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        return Effect.logError(`Registration failed: ${msg}`).pipe(
          Effect.zipRight(Effect.sync(() => process.exit(1))),
        );
      }),
    );
  },
).pipe(
  Command.withDescription(
    "Register a new agent on MoltZap (requires invite code)",
  ),
);
