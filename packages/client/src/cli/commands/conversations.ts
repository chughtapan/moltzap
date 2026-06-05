/**
 * D3 cutover: only `history` survives; legacy list/create/archive/etc.
 * subcommands ship in the D3 ADD slice once typed `Task*` CLI helpers
 * land at the transport boundary.
 */
import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { ConversationId } from "@moltzap/protocol/conversation";
import { TaskId } from "@moltzap/protocol/task";
import { LocalDaemonCommands } from "../../local-daemon-rpc.js";
import { command, runHandler } from "../transport.js";
import { logJson, logLines } from "../output.js";
import type { HistoryRequest } from "../../local-history.js";

const DEFAULT_HISTORY_LIMIT = 50;

const historyLimitOption = Options.integer("limit").pipe(
  Options.withDefault(DEFAULT_HISTORY_LIMIT),
  Options.withDescription("Max messages to show"),
);

const sessionKeyOption = Options.text("session-key").pipe(
  Options.withDescription("Session key for cross-conversation context"),
  Options.optional,
);

const taskIdArg = Args.text({ name: "taskId" }).pipe(
  Args.withSchema(TaskId),
  Args.withDescription("Task ID"),
);

const conversationIdArg = Args.text({ name: "conversationId" }).pipe(
  Args.withSchema(ConversationId),
  Args.withDescription("Conversation ID"),
);

const historyHandler = ({
  taskId,
  conversationId,
  limit,
  sessionKey,
}: {
  taskId: TaskId;
  conversationId: ConversationId;
  limit: number;
  sessionKey: Option.Option<string>;
}) => {
  const params: HistoryRequest = Option.isSome(sessionKey)
    ? { taskId, conversationId, limit, sessionKey: sessionKey.value }
    : { taskId, conversationId, limit };
  return runHandler(
    command(LocalDaemonCommands.History, params).pipe(
      Effect.flatMap(logJson),
      Effect.asVoid,
    ),
  );
};

const historySubcommand = Command.make(
  "history",
  {
    taskId: taskIdArg,
    conversationId: conversationIdArg,
    limit: historyLimitOption,
    sessionKey: sessionKeyOption,
  },
  historyHandler,
).pipe(Command.withDescription("Show message history for a conversation"));

/**
 * `moltzap conversations [history]` — the legacy CRUD subcommands
 * retire with the `Conversations*` wire surface; restructure to
 * `Task*` / `TaskConversation*` ships in the D3 ADD slice.
 */
export const conversationsCommand = Command.make("conversations", {}, () =>
  logLines([
    "moltzap conversations: only `history` is supported in this release.",
    "See `moltzap conversations history --help`.",
  ]),
).pipe(
  Command.withDescription("Show conversation history"),
  Command.withSubcommands([historySubcommand]),
);

/** Top-level `moltzap history &lt;taskId> &lt;conversationId>` — identical to `conversations history`. */
export const historyCommand = Command.make(
  "history",
  {
    taskId: taskIdArg,
    conversationId: conversationIdArg,
    limit: historyLimitOption,
    sessionKey: sessionKeyOption,
  },
  historyHandler,
).pipe(Command.withDescription("Show message history for a conversation"));
