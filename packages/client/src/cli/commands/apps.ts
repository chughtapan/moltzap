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
 *   apps attest-skill   → apps/attestSkill
 *
 * Every handler is an Effect requiring the {@link Transport} tag; impl-staff
 * wires each into `Command.make(...)` per the existing `@effect/cli` pattern
 * already used by `commands/conversations.ts` and adds the top-level
 * `appsCommand` to `cli/index.ts`.
 *
 * Invariant §4.6 (exit codes): success ⇒ exit 0, structural output on stdout.
 * RPC errors ⇒ non-zero exit, message on stderr, no silent swallow.
 */
import type { Effect } from "effect";
import type { Transport, TransportError } from "../transport.js";

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
 * The RPC params are `{ challengeId, skillUrl, version }`
 * (`packages/protocol/src/schema/methods/apps.ts:AppsAttestSkill`). The spec
 * flag `--session <id>` maps to `challengeId` and the spec flag `--skill <id>`
 * maps to `skillUrl`. `version` is a required RPC field not named in the
 * spec flag list; see Open question Q-AS-1 in the design doc.
 */
export interface AppsAttestSkillArgs {
  readonly challengeId: string;
  readonly skillUrl: string;
  readonly version: string;
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/** Wraps `apps/register`. Prints the registered app id to stdout. */
export const appsRegisterHandler = (
  _args: AppsRegisterArgs,
): Effect.Effect<void, AppsCommandError, Transport> => {
  throw new Error("not implemented");
};

/** Wraps `apps/create`. Prints `session.id` to stdout. */
export const appsCreateHandler = (
  _args: AppsCreateArgs,
): Effect.Effect<void, AppsCommandError, Transport> => {
  throw new Error("not implemented");
};

/** Wraps `apps/listSessions`. Emits one session per line. */
export const appsListHandler = (
  _args: AppsListArgs,
): Effect.Effect<void, AppsCommandError, Transport> => {
  throw new Error("not implemented");
};

/** Wraps `apps/getSession`. Prints the session record as JSON. */
export const appsGetHandler = (
  _args: AppsGetArgs,
): Effect.Effect<void, AppsCommandError, Transport> => {
  throw new Error("not implemented");
};

/** Wraps `apps/closeSession`. Prints the closed session id. */
export const appsCloseHandler = (
  _args: AppsCloseArgs,
): Effect.Effect<void, AppsCommandError, Transport> => {
  throw new Error("not implemented");
};

/** Wraps `apps/attestSkill`. Prints the attestation record. */
export const appsAttestSkillHandler = (
  _args: AppsAttestSkillArgs,
): Effect.Effect<void, AppsCommandError, Transport> => {
  throw new Error("not implemented");
};
