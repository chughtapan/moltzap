/**
 * `moltzap messages &lt;subcommand>` — subcommand group.
 *
 *   messages list → messages/list
 *
 * `messages` is a subcommand group (distinct from the one-shot top-level
 * `send` command). `--cursor` is absent: it has no server backing in the
 * current protocol.
 */
import { Command, HelpDoc, Options } from "@effect/cli";
import { Data, Effect, Option, Schema } from "effect";
import {
  rpc,
  runHandler,
  type Transport,
  type TransportError,
} from "../transport.js";

import { MessagesList } from "@moltzap/protocol";
import { ConversationId, TaskId } from "@moltzap/protocol/task";

// ─── Errors ────────────────────────────────────────────────────────────────

export type MessagesCommandError = TransportError | MessagesInputError;

class MessagesInputError extends Data.TaggedError("MessagesInputError")<{
  readonly message: string;
  readonly reason: string;
}> {}

// ─── Input shapes ──────────────────────────────────────────────────────────

/**
 * `moltzap messages list --conversation &lt;id> [--limit N]`. `cursor` is
 * absent: no server backing in the current protocol.
 */
export interface MessagesListArgs {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly limit?: number;
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/**
 * Wraps `messages/list`. Emits one message per line, tab-separated:
 * `&lt;createdAt>\t&lt;senderName ?? senderId>\t&lt;text>`. The wire shape carries
 * `id`, `senderId`, optional `senderName`, `createdAt`, and `parts`.
 */
export const messagesListHandler = (
  args: MessagesListArgs,
): Effect.Effect<void, MessagesCommandError, Transport> =>
  Effect.gen(function* () {
    const params =
      args.limit === undefined
        ? { taskId: args.taskId, conversationId: args.conversationId }
        : {
            taskId: args.taskId,
            conversationId: args.conversationId,
            limit: args.limit,
          };
    const result = yield* rpc(MessagesList, params);
    yield* Effect.sync(() => {
      for (const m of result.messages) {
        const text = m.parts.find((p) => p.type === "text")?.text ?? "";
        const sender =
          "senderName" in m && typeof m.senderName === "string"
            ? m.senderName
            : m.senderId;
        console.log(`${m.createdAt}\t${sender}\t${text}`);
      }
      if (result.hasMore) {
        console.log("... more messages available");
      }
    });
  }).pipe(Effect.withSpan("messagesListHandler"));

// ─── CLI commands ──────────────────────────────────────────────────────────

const taskOption = Options.text("task").pipe(
  Options.withDescription("Task id"),
  Options.mapTryCatch(
    (raw) => Schema.decodeUnknownSync(TaskId)(raw),
    (err) => HelpDoc.p(`invalid --task: ${String(err)}`),
  ),
);
const conversationOption = Options.text("conversation").pipe(
  Options.withDescription("Conversation id"),
  Options.mapTryCatch(
    (raw) => Schema.decodeUnknownSync(ConversationId)(raw),
    (err) => HelpDoc.p(`invalid --conversation: ${String(err)}`),
  ),
);
const msgLimitOption = Options.integer("limit").pipe(Options.optional);

const messagesListCommand = Command.make(
  "list",
  { task: taskOption, conversation: conversationOption, limit: msgLimitOption },
  ({ task, conversation, limit }) => {
    const args: MessagesListArgs = {
      taskId: task,
      conversationId: conversation,
      ...(Option.isSome(limit) ? { limit: limit.value } : {}),
    };
    return runHandler(messagesListHandler(args));
  },
).pipe(Command.withDescription("List messages in a conversation"));

/** `moltzap messages [list]` subcommand group. */
export const messagesCommand = Command.make("messages", {}, () =>
  Effect.sync(() => {
    console.log(
      "Usage: moltzap messages list --task <id> --conversation <id> [--limit N]",
    );
  }),
).pipe(
  Command.withDescription(
    "Query message history. Runs as the identity selected by the global " +
      "--as / --profile flags (see `moltzap --help`); visibility is scoped " +
      "to conversations that caller participates in.",
  ),
  Command.withSubcommands([messagesListCommand]),
);
