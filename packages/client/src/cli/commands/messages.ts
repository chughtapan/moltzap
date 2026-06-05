/**
 * `moltzap messages &lt;subcommand>` — subcommand group.
 *
 *   messages list → messages/list
 *
 * `messages` is a subcommand group (distinct from the one-shot top-level
 * `send` command). `--cursor` is absent: it has no server backing in the
 * current protocol.
 */
import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import {
  command,
  runHandler,
  type Transport,
  type TransportError,
} from "../transport.js";
import { logJson, logLines } from "../output.js";

import { ConversationId } from "@moltzap/protocol/conversation";
import { TaskId } from "@moltzap/protocol/task";
import { LocalDaemonCommands } from "../../local-daemon-rpc.js";

// ─── Errors ────────────────────────────────────────────────────────────────

export type MessagesCommandError = TransportError;

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
 * Wraps `messages/list` and emits the full daemon result as JSON.
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
    const result = yield* command(LocalDaemonCommands.MessagesList, params);
    yield* logJson(result);
  }).pipe(Effect.withSpan("messagesListHandler"));

// ─── CLI commands ──────────────────────────────────────────────────────────

const taskOption = Options.text("task").pipe(
  Options.withSchema(TaskId),
  Options.withDescription("Task id"),
);
const conversationOption = Options.text("conversation").pipe(
  Options.withSchema(ConversationId),
  Options.withDescription("Conversation id"),
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
  logLines([
    "Usage: moltzap messages list --task <id> --conversation <id> [--limit N]",
  ]),
).pipe(
  Command.withDescription(
    "Query message history. Runs as the identity selected by the global " +
      "--profile flag (see `moltzap --help`); visibility is scoped " +
      "to conversations that caller participates in.",
  ),
  Command.withSubcommands([messagesListCommand]),
);
