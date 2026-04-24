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
 * verifies against the server handler during impl; if admin-only the
 * `grant` subcommand escalates back to spec (does not silently default to
 * no-op or skip).
 *
 * Impl-staff wires handlers into `Command.make(...)` and registers
 * `permissionsCommand` in `cli/index.ts`.
 */
import type { Effect } from "effect";
import type { Transport, TransportError } from "../transport.js";

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
  _args: PermissionsGrantArgs,
): Effect.Effect<void, PermissionsCommandError, Transport> => {
  throw new Error("not implemented");
};

/**
 * Wraps `permissions/list`. Emits one grant per line (appId, resource,
 * access[], grantedAt).
 */
export const permissionsListHandler = (
  _args: PermissionsListArgs,
): Effect.Effect<void, PermissionsCommandError, Transport> => {
  throw new Error("not implemented");
};

/** Wraps `permissions/revoke`. Emits a success marker to stdout. */
export const permissionsRevokeHandler = (
  _args: PermissionsRevokeArgs,
): Effect.Effect<void, PermissionsCommandError, Transport> => {
  throw new Error("not implemented");
};
