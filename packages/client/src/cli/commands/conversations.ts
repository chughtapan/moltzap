import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import {
  type ConversationId,
  conversationId,
} from "@moltzap/protocol/conversation";
import { type TaskId, taskId } from "@moltzap/protocol/task";
import { localDaemonCommands } from "../../local-daemon-rpc.js";
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
  Args.withSchema(taskId),
  Args.withDescription("Task ID"),
);

const conversationIdArg = Args.text({ name: "conversationId" }).pipe(
  Args.withSchema(conversationId),
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
    command(localDaemonCommands.history, params).pipe(
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

/** Provides the conversations command runtime value. */
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
