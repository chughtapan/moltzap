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
 * Open question Q-M-1 (see design doc §8): `--cursor` has no server
 * backing in the current protocol; ESCALATED to spec rev 4. The flag is
 * deliberately absent from this interface until resolved.
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

interface WireMessage {
  readonly id: string;
  readonly seq: number;
  readonly senderId: string;
  readonly senderName?: string;
  readonly createdAt: string;
  readonly parts: ReadonlyArray<{ type: string; text?: string }>;
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/**
 * Wraps `messages/list`. Emits one message per line (seq, senderName, text).
 * `--json` is a stretch flag added by impl if consistent with
 * `conversations list` output style (not fixed by spec).
 */
export const messagesListHandler = (
  args: MessagesListArgs,
): Effect.Effect<void, MessagesCommandError, Transport> =>
  Effect.gen(function* () {
    const params: Record<string, unknown> = {
      conversationId: args.conversationId,
    };
    if (args.limit !== undefined) params.limit = args.limit;
    const result = yield* rpc<{
      messages: ReadonlyArray<WireMessage>;
      hasMore: boolean;
    }>("messages/list", params);
    yield* Effect.sync(() => {
      for (const m of result.messages) {
        const text = m.parts.find((p) => p.type === "text")?.text ?? "";
        const sender = m.senderName ?? m.senderId;
        console.log(`${m.seq}\t${sender}\t${text}`);
      }
      if (result.hasMore) {
        console.log("... more messages available");
      }
    });
  });

// ─── CLI commands ──────────────────────────────────────────────────────────

const conversationOption = Options.text("conversation").pipe(
  Options.withDescription("Conversation id"),
);
const msgLimitOption = Options.integer("limit").pipe(Options.optional);

const messagesListCommand = Command.make(
  "list",
  { conversation: conversationOption, limit: msgLimitOption },
  ({ conversation, limit }) => {
    const args: MessagesListArgs = {
      conversationId: conversation,
      ...(Option.isSome(limit) ? { limit: limit.value } : {}),
    };
    return runHandler(messagesListHandler(args));
  },
).pipe(Command.withDescription("List messages in a conversation"));

/** `moltzap messages [list]` subcommand group. */
export const messagesCommand = Command.make("messages", {}, () =>
  Effect.sync(() => {
    console.log("Usage: moltzap messages list --conversation <id> [--limit N]");
  }),
).pipe(
  Command.withDescription("Query message history"),
  Command.withSubcommands([messagesListCommand]),
);
