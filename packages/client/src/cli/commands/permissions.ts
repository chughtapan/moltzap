/**
 * `moltzap permissions <subcommand>` — handlers for spec sbd#177 rev 3 §5.4.
 *
 * Three subcommands, one RPC each:
 *
 *   permissions grant   → permissions/grant
 *   permissions list    → permissions/list
 *   permissions revoke  → permissions/revoke
 *
 * Auth model: Assumption §6.2 — agent-scoped (not admin-only). Architect
 * verified against the server handler during impl (Q-PG-1 RESOLVED HIGH).
 */
import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import {
  rpc,
  runHandler,
  type Transport,
  type TransportError,
} from "../transport.js";

// ─── Errors ────────────────────────────────────────────────────────────────

/** Exhaustive error union for the permissions surface. */
export type PermissionsCommandError = TransportError | PermissionsInputError;

export class PermissionsInputError extends Error {
  readonly _tag = "PermissionsInputError" as const;
  constructor(readonly reason: string) {
    super(reason);
  }
}

// ─── Input shapes ──────────────────────────────────────────────────────────

/**
 * `moltzap permissions grant --session <id> --agent <id> --resource <r>
 * --access <a>...` — spec §5.4 bullet 1. `access` is `--access` repeated
 * per Assumption §6.4.
 */
export interface PermissionsGrantArgs {
  readonly sessionId: string;
  readonly agentId: string;
  readonly resource: string;
  readonly access: ReadonlyArray<string>;
}

/** `moltzap permissions list [--app <id>]` — spec §5.4 bullet 2. */
export interface PermissionsListArgs {
  readonly appId?: string;
}

/** `moltzap permissions revoke --app <id> --resource <r>` — spec §5.4 bullet 3. */
export interface PermissionsRevokeArgs {
  readonly appId: string;
  readonly resource: string;
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/** Wraps `permissions/grant`. Emits a success marker to stdout. */
export const permissionsGrantHandler = (
  args: PermissionsGrantArgs,
): Effect.Effect<void, PermissionsCommandError, Transport> =>
  Effect.gen(function* () {
    if (args.access.length === 0) {
      return yield* Effect.fail(
        new PermissionsInputError(
          "--access requires at least one value (e.g. --access read)",
        ),
      );
    }
    yield* rpc<Record<string, never>>("permissions/grant", {
      sessionId: args.sessionId,
      agentId: args.agentId,
      resource: args.resource,
      access: [...args.access],
    });
    yield* Effect.sync(() => {
      console.log(
        `granted: agent=${args.agentId} resource=${args.resource} access=${args.access.join(",")}`,
      );
    });
  });

/**
 * Wraps `permissions/list`. Emits one grant per line (appId, resource,
 * access[], grantedAt).
 */
export const permissionsListHandler = (
  args: PermissionsListArgs,
): Effect.Effect<void, PermissionsCommandError, Transport> =>
  Effect.gen(function* () {
    const params: Record<string, unknown> = {};
    if (args.appId !== undefined) params.appId = args.appId;
    const result = yield* rpc<{
      grants: ReadonlyArray<{
        appId: string;
        resource: string;
        access: ReadonlyArray<string>;
        grantedAt: string;
      }>;
    }>("permissions/list", params);
    yield* Effect.sync(() => {
      for (const g of result.grants) {
        console.log(
          `${g.appId}\t${g.resource}\t${g.access.join(",")}\t${g.grantedAt}`,
        );
      }
    });
  });

/** Wraps `permissions/revoke`. Emits a success marker to stdout. */
export const permissionsRevokeHandler = (
  args: PermissionsRevokeArgs,
): Effect.Effect<void, PermissionsCommandError, Transport> =>
  Effect.gen(function* () {
    yield* rpc<Record<string, never>>("permissions/revoke", {
      appId: args.appId,
      resource: args.resource,
    });
    yield* Effect.sync(() => {
      console.log(`revoked: app=${args.appId} resource=${args.resource}`);
    });
  });

// ─── CLI commands ──────────────────────────────────────────────────────────

const sessionOption = Options.text("session").pipe(
  Options.withDescription("Session id"),
);
const agentOption = Options.text("agent").pipe(
  Options.withDescription("Agent id"),
);
const resourceOption = Options.text("resource").pipe(
  Options.withDescription("Resource identifier"),
);
const accessOption = Options.text("access").pipe(
  Options.withDescription("Access kind (repeatable)"),
  Options.repeated,
);

const permissionsGrantCommand = Command.make(
  "grant",
  {
    session: sessionOption,
    agent: agentOption,
    resource: resourceOption,
    access: accessOption,
  },
  ({ session, agent, resource, access }) =>
    runHandler(
      permissionsGrantHandler({
        sessionId: session,
        agentId: agent,
        resource,
        access,
      }),
    ),
).pipe(Command.withDescription("Grant permissions on a session resource"));

const permAppOption = Options.text("app").pipe(
  Options.withDescription("Filter by app id"),
  Options.optional,
);

const permissionsListCommand = Command.make(
  "list",
  { app: permAppOption },
  ({ app }) => {
    const args: PermissionsListArgs = Option.isSome(app)
      ? { appId: app.value }
      : {};
    return runHandler(permissionsListHandler(args));
  },
).pipe(Command.withDescription("List active permission grants"));

const revokeAppOption = Options.text("app").pipe(
  Options.withDescription("App id"),
);
const revokeResourceOption = Options.text("resource").pipe(
  Options.withDescription("Resource identifier"),
);

const permissionsRevokeCommand = Command.make(
  "revoke",
  { app: revokeAppOption, resource: revokeResourceOption },
  ({ app, resource }) =>
    runHandler(permissionsRevokeHandler({ appId: app, resource })),
).pipe(Command.withDescription("Revoke a permission"));

/** `moltzap permissions [grant|list|revoke]` subcommand group. */
export const permissionsCommand = Command.make("permissions", {}, () =>
  Effect.sync(() => {
    console.log("Usage: moltzap permissions <grant|list|revoke> [options]");
  }),
).pipe(
  Command.withDescription(
    "Manage session permissions. Runs as the identity selected by the " +
      "global --as / --profile flags (see `moltzap --help`); grants/revokes " +
      "are scoped to that caller's owner id.",
  ),
  Command.withSubcommands([
    permissionsGrantCommand,
    permissionsListCommand,
    permissionsRevokeCommand,
  ]),
);
