/**
 * `moltzap apps <subcommand>` — handlers for spec sbd#177 rev 3 §5.3.
 *
 * Six subcommands, each a one-to-one wrap of a JSON-RPC method defined in
 * `packages/protocol/src/schema/methods/apps.ts`:
 *
 *   apps register       → apps/register
 *   apps create         → apps/create
 *   apps list           → apps/listSessions
 *   apps get            → apps/getSession
 *   apps close          → apps/closeSession
 *   apps attest-skill   → apps/attestSkill   (ESCALATED Q-AS-1, stub only)
 *
 * Every handler is an Effect requiring the {@link Transport} tag; impl-staff
 * wires each into `Command.make(...)` per the existing `@effect/cli` pattern
 * already used by `commands/conversations.ts` and adds the top-level
 * `appsCommand` to `cli/index.ts`.
 *
 * Invariant §4.6 (exit codes): success ⇒ exit 0, structural output on stdout.
 * RPC errors ⇒ non-zero exit, message on stderr, no silent swallow.
 */
import * as fs from "node:fs";
import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import {
  rpc,
  runHandler,
  type Transport,
  type TransportError,
} from "../transport.js";

// ─── Errors ────────────────────────────────────────────────────────────────

/**
 * Error union for the apps subcommand surface. Additional tags must be
 * declared here, not thrown ad-hoc (Principle 3).
 */
export type AppsCommandError = TransportError | AppsInputError;

/** CLI argument parsing rejected a value (e.g. `--manifest` points to a missing file). */
export class AppsInputError extends Error {
  readonly _tag = "AppsInputError" as const;
  constructor(readonly reason: string) {
    super(reason);
  }
}

// ─── Input shapes ──────────────────────────────────────────────────────────

/** `moltzap apps register --manifest <file>` — spec §5.3 bullet 1. */
export interface AppsRegisterArgs {
  readonly manifestPath: string;
}

/**
 * `moltzap apps create --app <id> --invite <agentId>...` — spec §5.3 bullet 2.
 * `invitedAgentIds` is `--invite` repeated per Assumption §6.4.
 */
export interface AppsCreateArgs {
  readonly appId: string;
  readonly invitedAgentIds: ReadonlyArray<string>;
}

/**
 * `moltzap apps list [--app <id>] [--status waiting|active|closed]` —
 * spec §5.3 bullet 3. `status` is a discriminated union so impl and
 * tests branch exhaustively.
 */
export interface AppsListArgs {
  readonly appId?: string;
  readonly status?: AppSessionStatus;
  readonly limit?: number;
}

/** Mirror of the protocol's `apps/listSessions.params.status` enum. */
export type AppSessionStatus = "waiting" | "active" | "closed";

/** `moltzap apps get <sessionId>` — spec §5.3 bullet 4. */
export interface AppsGetArgs {
  readonly sessionId: string;
}

/** `moltzap apps close <sessionId>` — spec §5.3 bullet 5. */
export interface AppsCloseArgs {
  readonly sessionId: string;
}

/**
 * `moltzap apps attest-skill --session <id> --skill <id>` — spec §5.3 bullet 6.
 *
 * ESCALATED (Q-AS-1, spec rev 4). The stub remains here so the module
 * compiles; impl-staff does NOT wire a `Command.make` for this subcommand.
 */
export interface AppsAttestSkillArgs {
  readonly challengeId: string;
  readonly skillUrl: string;
  readonly version: string;
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/** Wraps `apps/register`. Prints the registered app id to stdout. */
export const appsRegisterHandler = (
  args: AppsRegisterArgs,
): Effect.Effect<void, AppsCommandError, Transport> =>
  Effect.gen(function* () {
    let manifestText: string;
    try {
      manifestText = fs.readFileSync(args.manifestPath, "utf-8");
    } catch (err) {
      return yield* Effect.fail(
        new AppsInputError(
          `manifest not readable at ${args.manifestPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch (err) {
      return yield* Effect.fail(
        new AppsInputError(
          `manifest at ${args.manifestPath} is not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
    const result = yield* rpc<{ appId: string }>("apps/register", {
      manifest,
    });
    yield* Effect.sync(() => {
      console.log(result.appId);
    });
  });

/** Wraps `apps/create`. Prints `session.id` to stdout. */
export const appsCreateHandler = (
  args: AppsCreateArgs,
): Effect.Effect<void, AppsCommandError, Transport> =>
  Effect.gen(function* () {
    const result = yield* rpc<{ session: { id: string } }>("apps/create", {
      appId: args.appId,
      invitedAgentIds: [...args.invitedAgentIds],
    });
    yield* Effect.sync(() => {
      console.log(result.session.id);
    });
  });

/** Wraps `apps/listSessions`. Emits one session per line. */
export const appsListHandler = (
  args: AppsListArgs,
): Effect.Effect<void, AppsCommandError, Transport> =>
  Effect.gen(function* () {
    const params: Record<string, unknown> = {};
    if (args.appId !== undefined) params.appId = args.appId;
    if (args.status !== undefined) params.status = args.status;
    if (args.limit !== undefined) params.limit = args.limit;
    const result = yield* rpc<{
      sessions: ReadonlyArray<{
        id: string;
        appId: string;
        status: AppSessionStatus;
      }>;
    }>("apps/listSessions", params);
    yield* Effect.sync(() => {
      for (const s of result.sessions) {
        console.log(`${s.id}\t${s.appId}\t${s.status}`);
      }
    });
  });

/** Wraps `apps/getSession`. Prints the session record as JSON. */
export const appsGetHandler = (
  args: AppsGetArgs,
): Effect.Effect<void, AppsCommandError, Transport> =>
  Effect.gen(function* () {
    const result = yield* rpc<{ session: unknown }>("apps/getSession", {
      sessionId: args.sessionId,
    });
    yield* Effect.sync(() => {
      console.log(JSON.stringify(result.session, null, 2));
    });
  });

/** Wraps `apps/closeSession`. Prints the closed session id. */
export const appsCloseHandler = (
  args: AppsCloseArgs,
): Effect.Effect<void, AppsCommandError, Transport> =>
  Effect.gen(function* () {
    yield* rpc<{ closed: boolean }>("apps/closeSession", {
      sessionId: args.sessionId,
    });
    yield* Effect.sync(() => {
      console.log(args.sessionId);
    });
  });

/**
 * Wraps `apps/attestSkill` — spec rev 4 addendum §3 (Q-AS-1 resolved).
 *
 * All three flags are required; the RPC result is `{}`.
 * Exit 0 on success with no stdout payload (Invariant §4.6; result is void).
 */
export const appsAttestSkillHandler = (
  args: AppsAttestSkillArgs,
): Effect.Effect<void, AppsCommandError, Transport> =>
  rpc<Record<string, never>>("apps/attestSkill", {
    challengeId: args.challengeId,
    skillUrl: args.skillUrl,
    version: args.version,
  }).pipe(Effect.asVoid);

// ─── CLI commands ──────────────────────────────────────────────────────────

const manifestOption = Options.file("manifest").pipe(
  Options.withDescription("App manifest file"),
);

const appsRegisterCommand = Command.make(
  "register",
  { manifest: manifestOption },
  ({ manifest }) => runHandler(appsRegisterHandler({ manifestPath: manifest })),
).pipe(Command.withDescription("Register an app via apps/register"));

const appOption = Options.text("app").pipe(
  Options.withDescription(
    "App id — matches the `appId` field in the manifest previously " +
      "submitted via `moltzap apps register --manifest ...`.",
  ),
);
const inviteOption = Options.text("invite").pipe(
  Options.withDescription(
    "Invited agent id (UUID, not the friendly agent-name). " +
      "Get it from the `Agent ID:` line printed by `moltzap register` or " +
      "from `moltzap whoami` on the peer's host. Repeat the flag to invite " +
      "multiple agents: --invite <uuid1> --invite <uuid2>.",
  ),
  Options.repeated,
);

/**
 * `moltzap apps create --app <appId> --invite <agentId>...`
 *
 * Initiator is the CALLER: whichever identity the transport layer resolves
 * from the global `--as` / `--profile` flags (or the default profile when
 * neither is given) becomes `initiatorAgentId` on the server side — see
 * `apps/create` handler at packages/server/src/app/handlers/apps.handlers.ts
 * (uses `ctx.agentId`). The initiator is NOT passed as a CLI argument and
 * does NOT appear in `--invite`.
 *
 * Typical multi-agent flow:
 *   # as the initiator (e.g. alice):
 *   moltzap --profile alice apps create --app myapp \
 *     --invite $BOB_AGENT_ID --invite $CAROL_AGENT_ID
 *
 * Prints the new session id to stdout (one line) on success.
 */
const appsCreateCommand = Command.make(
  "create",
  { app: appOption, invite: inviteOption },
  ({ app, invite }) =>
    runHandler(
      appsCreateHandler({ appId: app, invitedAgentIds: invite }),
    ),
).pipe(
  Command.withDescription(
    "Create a new app session. Caller becomes the initiator; --invite " +
      "takes an agent id (UUID) and is repeatable.",
  ),
);

const appFilterOption = Options.text("app").pipe(
  Options.withDescription("Filter by app id"),
  Options.optional,
);
const statusOption = Options.choice("status", [
  "waiting",
  "active",
  "closed",
] as const).pipe(Options.optional);
const limitOption = Options.integer("limit").pipe(Options.optional);

const appsListCommand = Command.make(
  "list",
  {
    app: appFilterOption,
    status: statusOption,
    limit: limitOption,
  },
  ({ app, status, limit }) => {
    const args: AppsListArgs = {
      ...(Option.isSome(app) ? { appId: app.value } : {}),
      ...(Option.isSome(status) ? { status: status.value } : {}),
      ...(Option.isSome(limit) ? { limit: limit.value } : {}),
    };
    return runHandler(appsListHandler(args));
  },
).pipe(Command.withDescription("List app sessions"));

const sessionIdArg = Args.text({ name: "sessionId" }).pipe(
  Args.withDescription("Session id"),
);

const appsGetCommand = Command.make(
  "get",
  { sessionId: sessionIdArg },
  ({ sessionId }) => runHandler(appsGetHandler({ sessionId })),
).pipe(Command.withDescription("Get an app session as JSON"));

const appsCloseCommand = Command.make(
  "close",
  { sessionId: sessionIdArg },
  ({ sessionId }) => runHandler(appsCloseHandler({ sessionId })),
).pipe(Command.withDescription("Close an app session"));

const challengeIdOption = Options.text("challenge-id").pipe(
  Options.withDescription("Challenge id (UUID) from the attestation challenge"),
);
const skillUrlOption = Options.text("skill-url").pipe(
  Options.withDescription("Skill URL being attested"),
);
const versionOption = Options.text("version").pipe(
  Options.withDescription("Skill version string"),
);

/**
 * `moltzap apps attest-skill --challenge-id <id> --skill-url <url> --version <v>`
 *
 * Wraps `apps/attestSkill`. All three flags required.
 * Exits 0 on success with no stdout; error to stderr with non-zero exit
 * (spec rev 4 addendum §3 Q-AS-1; Invariant §4.6).
 */
const appsAttestSkillCommand = Command.make(
  "attest-skill",
  {
    challengeId: challengeIdOption,
    skillUrl: skillUrlOption,
    version: versionOption,
  },
  ({ challengeId, skillUrl, version }) =>
    runHandler(appsAttestSkillHandler({ challengeId, skillUrl, version })),
).pipe(
  Command.withDescription(
    "Attest a skill for a session. All three flags are required.",
  ),
);

/** `moltzap apps [register|create|list|get|close|attest-skill]` — subcommand group. */
export const appsCommand = Command.make("apps", {}, () =>
  Effect.sync(() => {
    console.log(
      "Usage: moltzap apps <register|create|list|get|close|attest-skill> [options]",
    );
  }),
).pipe(
  Command.withDescription(
    "Manage MoltZap apps and sessions. Every subcommand runs as the " +
      "identity selected by the global --as / --profile flags (see " +
      "`moltzap --help`); in particular `apps create` makes the caller " +
      "the session initiator.",
  ),
  Command.withSubcommands([
    appsRegisterCommand,
    appsCreateCommand,
    appsListCommand,
    appsGetCommand,
    appsCloseCommand,
    appsAttestSkillCommand,
  ]),
);
