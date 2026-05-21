/**
 * Spec D3 (#600) D10 cutover: the legacy `Conversations*` RPC family
 * retires; this module now exposes only the local-history surface and
 * a stub `conversations` parent that lists installed subcommands.
 *
 * Per spec body Goal 3 + D10, the prior list/get/create/archive/etc.
 * subcommands restructure to call `Task*` / `TaskConversation*` analogues.
 * The full restructure ships in a follow-up commit (D3 ADD scope) once
 * the SDK exposes typed helpers for `TaskCreate({appId, ...})` +
 * `TaskConversationCreate({taskId, ...})` from the CLI transport
 * boundary. For now, only `history` survives — every other subcommand's
 * underlying RPC is deleted by Commit 10 and the wire shape changes are
 * incompatible with a one-line rename.
 */
import { Args, Command, HelpDoc, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import {
  BrandedIdDecodeError,
  brandConversationId,
  brandTaskId,
} from "@moltzap/protocol/task";
import { LocalServiceCommands, requestLocalService } from "../socket-client.js";
import type {
  HistoryRequestInput,
  HistoryMessageSummary,
  HistoryResponse,
} from "../../runtime/local-history.js";

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output as JSON"),
);

const DEFAULT_HISTORY_LIMIT = 50;
const JSON_INDENT_SPACES = 2;
const MILLISECONDS_PER_MINUTE = 60_000;

const wrap = <A>(
  effect: Effect.Effect<A, Error>,
  onSuccess: (value: A) => void,
): Effect.Effect<void> =>
  effect.pipe(
    Effect.tap((value) => Effect.sync(() => onSuccess(value))),
    Effect.asVoid,
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }),
    ),
  );

const historyLimitOption = Options.integer("limit").pipe(
  Options.withDefault(DEFAULT_HISTORY_LIMIT),
  Options.withDescription("Max messages to show"),
);

const sessionKeyOption = Options.text("session-key").pipe(
  Options.withDescription("Session key for cross-conversation context"),
  Options.optional,
);

const taskIdArg = Args.text({ name: "taskId" }).pipe(
  Args.withDescription("Task ID"),
  Args.mapTryCatch(brandTaskId, (err) =>
    HelpDoc.p(
      err instanceof BrandedIdDecodeError
        ? `invalid taskId: ${err.input}`
        : `invalid taskId: ${String(err)}`,
    ),
  ),
);

const conversationIdArg = Args.text({ name: "conversationId" }).pipe(
  Args.withDescription("Conversation ID"),
  Args.mapTryCatch(brandConversationId, (err) =>
    HelpDoc.p(
      err instanceof BrandedIdDecodeError
        ? `invalid conversationId: ${err.input}`
        : `invalid conversationId: ${String(err)}`,
    ),
  ),
);

function renderHistoryHeader(
  conversationId: string,
  sessionKey: Option.Option<string>,
  result: HistoryResponse,
): void {
  if (!Option.isSome(sessionKey) || !result.conversationMeta) return;
  const label = result.conversationMeta.name ?? result.conversationMeta.type;
  console.log(
    `Conversation: ${label} (${conversationId}) | ${result.newCount} new`,
  );
  console.log("");
}

function messageAgeMinutes(createdAt: string): number {
  return Math.max(
    0,
    Math.round(
      (Date.now() - new Date(createdAt).getTime()) / MILLISECONDS_PER_MINUTE,
    ),
  );
}

function renderHistoryMessage(message: HistoryMessageSummary): void {
  const ago = messageAgeMinutes(message.createdAt);
  const newMarker = message.isNew ? " *" : "";
  console.log(
    `  [${ago}m ago] ${message.senderName}: ${message.text}${newMarker}`,
  );
}

const renderHistory = (
  conversationId: string,
  sessionKey: Option.Option<string>,
  result: HistoryResponse,
  json: boolean,
): void => {
  if (json) {
    console.log(JSON.stringify(result, null, JSON_INDENT_SPACES));
    return;
  }
  if (result.messages.length === 0) {
    console.log("No messages.");
    return;
  }
  renderHistoryHeader(conversationId, sessionKey, result);
  for (const message of result.messages) {
    renderHistoryMessage(message);
  }
  if (result.hasMore) {
    console.log("  ... more messages available");
  }
};

const historyHandler = ({
  taskId,
  conversationId,
  limit,
  json,
  sessionKey,
}: {
  taskId: string;
  conversationId: string;
  limit: number;
  json: boolean;
  sessionKey: Option.Option<string>;
}): Effect.Effect<void> => {
  const params: HistoryRequestInput = Option.isSome(sessionKey)
    ? { taskId, conversationId, limit, sessionKey: sessionKey.value }
    : { taskId, conversationId, limit };
  return wrap(
    requestLocalService(LocalServiceCommands.History, params),
    (result) => {
      renderHistory(conversationId, sessionKey, result, json);
    },
  );
};

const historySubcommand = Command.make(
  "history",
  {
    taskId: taskIdArg,
    conversationId: conversationIdArg,
    limit: historyLimitOption,
    json: jsonOption,
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
  Effect.sync(() => {
    console.log(
      "moltzap conversations: only `history` is supported in this release.",
    );
    console.log("See `moltzap conversations history --help`.");
  }),
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
    json: jsonOption,
    sessionKey: sessionKeyOption,
  },
  historyHandler,
).pipe(Command.withDescription("Show message history for a conversation"));
