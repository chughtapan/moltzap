/**
 * `moltzap apps <subcommand>` — handlers for spec sbd#177 rev 3 §5.3.
 *
 * Five subcommands, each a one-to-one wrap of a JSON-RPC method defined in
 * `packages/protocol/src/schema/methods/apps.ts`:
 *
 *   apps register       → apps/register
 *   apps create         → apps/create
 *   apps list           → apps/listSessions
 *   apps get            → apps/getSession
 *   apps close          → apps/closeSession
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
import { Data, Effect, Option } from "effect";
import {
  rpc,
  runHandler,
  type Transport,
  type TransportError,
} from "../transport.js";

import {
  agentId,
  AppsCloseSession,
  AppsCreate,
  AppsGetSession,
  AppsListSessions,
  AppsRegister,
} from "@moltzap/protocol";

// ─── Errors ────────────────────────────────────────────────────────────────

/**
 * Error union for the apps subcommand surface. Additional tags must be
 * declared here, not thrown ad-hoc (Principle 3).
 */
export type AppsCommandError = TransportError | AppsInputError;

/** CLI argument parsing rejected a value (e.g. `--manifest` points to a missing file). */
export class AppsInputError extends Data.TaggedError("AppsInputError")<{
  readonly message: string;
  readonly reason: string;
}> {}

const JSON_INDENT_SPACES = 2;

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
      const reason = `manifest not readable at ${args.manifestPath}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      return yield* Effect.fail(
        new AppsInputError({
          message: reason,
          reason,
        }),
      );
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch (err) {
      const reason = `manifest at ${args.manifestPath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`;
      return yield* Effect.fail(
        new AppsInputError({
          message: reason,
          reason,
        }),
      );
    }
    const params = { manifest };
    if (!AppsRegister.validateParams(params)) {
      return yield* Effect.fail(
        new AppsInputError({
          message: `manifest at ${args.manifestPath} does not match the app manifest schema`,
          reason: "invalid app manifest",
        }),
      );
    }
    const result = yield* rpc(AppsRegister, params);
    yield* Effect.sync(() => {
      console.log(result.appId);
    });
  });

/** Wraps `apps/create`. Prints `session.id` to stdout. */
export const appsCreateHandler = (
  args: AppsCreateArgs,
): Effect.Effect<void, AppsCommandError, Transport> =>
  Effect.gen(function* () {
    const result = yield* rpc(AppsCreate, {
      appId: args.appId,
      invitedAgentIds: args.invitedAgentIds.map(agentId),
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
    const params = {
      ...(args.appId !== undefined ? { appId: args.appId } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    };
    const result = yield* rpc(AppsListSessions, params);
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
    const result = yield* rpc(AppsGetSession, {
      sessionId: args.sessionId,
    });
    yield* Effect.sync(() => {
      console.log(JSON.stringify(result.session, null, JSON_INDENT_SPACES));
    });
  });

/** Wraps `apps/closeSession`. Prints the closed session id. */
export const appsCloseHandler = (
  args: AppsCloseArgs,
): Effect.Effect<void, AppsCommandError, Transport> =>
  Effect.gen(function* () {
    yield* rpc(AppsCloseSession, {
      sessionId: args.sessionId,
    });
    yield* Effect.sync(() => {
      console.log(args.sessionId);
    });
  });

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
    runHandler(appsCreateHandler({ appId: app, invitedAgentIds: invite })),
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

/** `moltzap apps [register|create|list|get|close]` — subcommand group. */
export const appsCommand = Command.make("apps", {}, () =>
  Effect.sync(() => {
    console.log(
      "Usage: moltzap apps <register|create|list|get|close> [options]",
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
  ]),
);
