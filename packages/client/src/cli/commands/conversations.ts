import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import {
  type ConversationId,
  conversationId,
} from "@moltzap/protocol/conversation";
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

const conversationIdArg = Args.text({ name: "conversationId" }).pipe(
  Args.withSchema(conversationId),
  Args.withDescription("Conversation ID"),
);

const historyHandler = ({
  conversationId,
  limit,
  sessionKey,
}: {
  conversationId: ConversationId;
  limit: number;
  sessionKey: Option.Option<string>;
}) => {
  const params: HistoryRequest = Option.isSome(sessionKey)
    ? { conversationId, limit, sessionKey: sessionKey.value }
    : { conversationId, limit };
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

/** Top-level `moltzap history &lt;conversationId>` — identical to `conversations history`. */
export const historyCommand = Command.make(
  "history",
  {
    conversationId: conversationIdArg,
    limit: historyLimitOption,
    sessionKey: sessionKeyOption,
  },
  historyHandler,
).pipe(Command.withDescription("Show message history for a conversation"));
