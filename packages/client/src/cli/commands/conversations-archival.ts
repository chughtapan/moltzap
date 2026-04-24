/**
 * `moltzap conversations {get,archive,unarchive}` — handlers for spec
 * sbd#177 rev 3 §5.6.
 *
 * Three subcommands, one RPC each:
 *
 *   conversations get       → conversations/get
 *   conversations archive   → conversations/archive
 *   conversations unarchive → conversations/unarchive
 *
 * Architect pick (spec §"Architect picks"). The existing
 * `commands/conversations.ts` already composes nine subcommands. Per the
 * architect rule "no edits to files that pre-date this branch," these
 * three handlers live in this temporary file. Impl-staff merges them into
 * `conversations.ts` and imports from there, then deletes this file in
 * the same PR (the file is an architectural parking space, not a lasting
 * module boundary).
 */
import type { Effect } from "effect";
import type { Transport, TransportError } from "../transport.js";

// ─── Errors ────────────────────────────────────────────────────────────────

export type ConversationsArchivalError =
  | TransportError
  | ConversationsArchivalInputError;

export class ConversationsArchivalInputError extends Error {
  readonly _tag = "ConversationsArchivalInputError" as const;
  constructor(readonly reason: string) {
    super(reason);
  }
}

// ─── Input shapes ──────────────────────────────────────────────────────────

/** `moltzap conversations get <id>` — spec §5.6 bullet 1. */
export interface ConversationsGetArgs {
  readonly conversationId: string;
}

/** `moltzap conversations archive <id>` — spec §5.6 bullet 2. */
export interface ConversationsArchiveArgs {
  readonly conversationId: string;
}

/** `moltzap conversations unarchive <id>` — spec §5.6 bullet 3. */
export interface ConversationsUnarchiveArgs {
  readonly conversationId: string;
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/**
 * Wraps `conversations/get`. Prints the conversation record + participants
 * as JSON (consistent with `conversations history --json`).
 */
export const conversationsGetHandler = (
  _args: ConversationsGetArgs,
): Effect.Effect<void, ConversationsArchivalError, Transport> => {
  throw new Error("not implemented");
};

/** Wraps `conversations/archive`. Emits a success marker. */
export const conversationsArchiveHandler = (
  _args: ConversationsArchiveArgs,
): Effect.Effect<void, ConversationsArchivalError, Transport> => {
  throw new Error("not implemented");
};

/** Wraps `conversations/unarchive`. Emits a success marker. */
export const conversationsUnarchiveHandler = (
  _args: ConversationsUnarchiveArgs,
): Effect.Effect<void, ConversationsArchivalError, Transport> => {
  throw new Error("not implemented");
};
