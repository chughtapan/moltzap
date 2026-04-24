/**
 * `moltzap messages <subcommand>` — handler for spec sbd#177 rev 3 §5.5.
 *
 * One subcommand in v1:
 *
 *   messages list → messages/list
 *
 * Architect pick (spec §"Architect picks"): new file, not an extension of
 * `commands/send.ts`. `send` is a one-shot top-level command; `messages`
 * is a subcommand group whose future v1.1 member (`messages tail`, deferred
 * per Non-goal §3.1) lands in the same file.
 *
 * Open question Q-M-1 (see design doc §8): the spec specifies a
 * `--cursor <c>` flag, but `packages/protocol/src/schema/methods/messages.ts`
 * `MessagesList.params` defines only `{ conversationId, limit }`. The
 * cursor flag has no server support in the current protocol. Architect
 * recommended default: drop `--cursor` from v1 and escalate to `/safer:spec`
 * for rev 4; do not invent a client-side cursor. See design doc §8 for the
 * full escalation.
 */
import type { Effect } from "effect";
import type { Transport, TransportError } from "../transport.js";

// ─── Errors ────────────────────────────────────────────────────────────────

export type MessagesCommandError = TransportError | MessagesInputError;

export class MessagesInputError extends Error {
  readonly _tag = "MessagesInputError" as const;
  constructor(readonly reason: string) {
    super(reason);
  }
}

// ─── Input shapes ──────────────────────────────────────────────────────────

/**
 * `moltzap messages list --conversation <id> [--limit N]` — spec §5.5.
 * `cursor` deliberately absent from this interface until the open
 * question is resolved.
 */
export interface MessagesListArgs {
  readonly conversationId: string;
  readonly limit?: number;
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/**
 * Wraps `messages/list`. Emits one message per line (seq, senderName, text).
 * `--json` is a stretch flag added by impl if consistent with
 * `conversations list` output style (not fixed by spec).
 */
export const messagesListHandler = (
  _args: MessagesListArgs,
): Effect.Effect<void, MessagesCommandError, Transport> => {
  throw new Error("not implemented");
};
