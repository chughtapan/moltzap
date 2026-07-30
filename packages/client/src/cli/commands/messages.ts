/**
 * `moltzap messages &lt;subcommand>` — subcommand group.
 *
 *   Messages list → agent/message/list.
 *
 * `messages` is a subcommand group, distinct from the one-shot top-level
 * `send` command.
 */
import { Command } from "@effect/cli";
import { Effect, type Schema } from "effect";
import {
  command,
  runHandler,
  type Transport,
  type TransportError,
} from "../transport.js";
import { logJson, logLines } from "../output.js";

import {
  localDaemonCommands,
  messagesListCommandRpc,
} from "../../local-daemon-rpc.js";
import { optionsFromSchema } from "../adapters.js";

const messagesListPayload = messagesListCommandRpc.payloadSchema;

// ─── Errors ────────────────────────────────────────────────────────────────

/** Represents messages command error conditions. */
export type MessagesCommandError = TransportError;

// ─── Input shapes ──────────────────────────────────────────────────────────

/** `moltzap messages list --conversation &lt;id> [--limit N]`. */
export type MessagesListArgs = Schema.Schema.Type<typeof messagesListPayload>;

// ─── Handlers ──────────────────────────────────────────────────────────────

/**
 * Wraps `agent/message/list` and emits the full daemon result as JSON.
 * @param args Value supplied to the operation.
 * @returns The messages list handler result.
 */
export const messagesListHandler = (
  args: MessagesListArgs,
): Effect.Effect<void, MessagesCommandError, Transport> =>
  Effect.gen(function* () {
    const result = yield* command(localDaemonCommands.messagesList, args);
    yield* logJson(result);
  }).pipe(Effect.withSpan("messagesListHandler"));

// ─── CLI commands ──────────────────────────────────────────────────────────

/** Provides the messages list options runtime value. */
export const messagesListOptions = optionsFromSchema(messagesListPayload, {
  taskId: { name: "task", description: "Task id" },
  conversationId: {
    name: "conversation",
    description: "Conversation id",
  },
});

const messagesListCommand = Command.make(
  "list",
  { params: messagesListOptions },
  ({ params }) => runHandler(messagesListHandler(params)),
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
