import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import type { ConversationSummary } from "@moltzap/protocol";
import { request, resolveParticipant } from "../socket-client.js";

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output as JSON"),
);

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

const limitOption = Options.integer("limit").pipe(
  Options.withDefault(20),
  Options.withDescription("Max conversations to list"),
);

const listConversations = Command.make(
  "list",
  { limit: limitOption, json: jsonOption },
  ({ limit, json }) =>
    wrap(
      request("conversations/list", { limit }) as Effect.Effect<
        { conversations: ConversationSummary[] },
        Error
      >,
      (r) => {
        if (json) {
          console.log(JSON.stringify(r.conversations, null, 2));
          return;
        }
        if (r.conversations.length === 0) {
          console.log("No conversations.");
          return;
        }
        for (const c of r.conversations) {
          const unread = c.unreadCount > 0 ? ` (${c.unreadCount} unread)` : "";
          const name = c.name ?? c.type;
          console.log(`  ${c.id}  ${name}${unread}`);
          if (c.lastMessagePreview) {
            console.log(`    Last: ${c.lastMessagePreview}`);
          }
        }
      },
    ),
).pipe(Command.withDescription("List conversations with unread counts"));

const nameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Conversation name"),
);

const participantArg = Args.text({ name: "participant" }).pipe(
  Args.withDescription("Participant (e.g. agent:bob)"),
);

const participantsArg = Args.text({ name: "participant" }).pipe(
  Args.withDescription("Participants (e.g. agent:bob)"),
  Args.repeated,
);

const typeOption = Options.text("type").pipe(
  Options.withDescription("Conversation type: dm or group"),
  Options.optional,
);

const createConversation = Command.make(
  "create",
  { name: nameArg, participants: participantsArg, type: typeOption },
  ({ name, participants, type }) =>
    Effect.gen(function* () {
      const parsed = yield* Effect.all(
        participants.map((p) => resolveParticipant(p)),
      );
      const convType = Option.isSome(type)
        ? type.value
        : parsed.length === 1
          ? "dm"
          : "group";
      const result = (yield* request("conversations/create", {
        type: convType,
        name,
        participants: parsed,
      })) as { conversation: { id: string; type: string } };
      console.log(
        `Conversation created: ${result.conversation.id} (${result.conversation.type})`,
      );
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          console.error(`Failed: ${err.message}`);
          process.exit(1);
        }),
      ),
    ),
).pipe(Command.withDescription("Create a new conversation"));

const conversationIdArg = Args.text({ name: "conversationId" }).pipe(
  Args.withDescription("Conversation ID"),
);

const leaveConversation = Command.make(
  "leave",
  { conversationId: conversationIdArg },
  ({ conversationId }) =>
    wrap(request("conversations/leave", { conversationId }), () => {
      console.log(`Left conversation ${conversationId}.`);
    }),
).pipe(Command.withDescription("Leave a conversation"));

const untilOption = Options.text("until").pipe(
  Options.withDescription("Mute until ISO datetime"),
  Options.optional,
);

const muteConversation = Command.make(
  "mute",
  { conversationId: conversationIdArg, until: untilOption },
  ({ conversationId, until }) => {
    const params: Record<string, string> = { conversationId };
    if (Option.isSome(until)) params.until = until.value;
    return wrap(request("conversations/mute", params), () => {
      console.log(
        Option.isSome(until)
          ? `Conversation ${conversationId} muted until ${until.value}.`
          : `Conversation ${conversationId} muted.`,
      );
    });
  },
).pipe(Command.withDescription("Mute a conversation"));

const unmuteConversation = Command.make(
  "unmute",
  { conversationId: conversationIdArg },
  ({ conversationId }) =>
    wrap(request("conversations/unmute", { conversationId }), () => {
      console.log(`Conversation ${conversationId} unmuted.`);
    }),
).pipe(Command.withDescription("Unmute a conversation"));

const nameOption = Options.text("name").pipe(
  Options.withDescription("New conversation name"),
);

const updateConversation = Command.make(
  "update",
  { conversationId: conversationIdArg, name: nameOption },
  ({ conversationId, name }) =>
    wrap(
      request("conversations/update", {
        conversationId,
        name,
      }) as Effect.Effect<
        { conversation: { id: string; name: string } },
        Error
      >,
      (r) => {
        console.log(
          `Conversation updated: ${r.conversation.id} (name: ${r.conversation.name})`,
        );
      },
    ),
).pipe(Command.withDescription("Update conversation settings"));

const addParticipantCommand = Command.make(
  "add-participant",
  { conversationId: conversationIdArg, participant: participantArg },
  ({ conversationId, participant }) =>
    Effect.gen(function* () {
      const ref = yield* resolveParticipant(participant);
      yield* request("conversations/addParticipant", {
        conversationId,
        participant: ref,
      });
      console.log(`Added ${participant} to ${conversationId}.`);
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          console.error(`Failed: ${err.message}`);
          process.exit(1);
        }),
      ),
    ),
).pipe(Command.withDescription("Add a participant to a conversation"));

const removeParticipantCommand = Command.make(
  "remove-participant",
  { conversationId: conversationIdArg, participant: participantArg },
  ({ conversationId, participant }) =>
    Effect.gen(function* () {
      const ref = yield* resolveParticipant(participant);
      yield* request("conversations/removeParticipant", {
        conversationId,
        participant: ref,
      });
      console.log(`Removed ${participant} from ${conversationId}.`);
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          console.error(`Failed: ${err.message}`);
          process.exit(1);
        }),
      ),
    ),
).pipe(Command.withDescription("Remove a participant from a conversation"));

interface HistoryMessage {
  seq: number;
  senderId: string;
  senderName: string;
  isOwn: boolean;
  text: string;
  createdAt: string;
  isNew: boolean;
}

interface HistoryResult {
  messages: HistoryMessage[];
  hasMore: boolean;
  conversationMeta?: { type: string; name?: string };
  newCount: number;
}

const historyLimitOption = Options.integer("limit").pipe(
  Options.withDefault(50),
  Options.withDescription("Max messages to show"),
);

const sessionKeyOption = Options.text("session-key").pipe(
  Options.withDescription("Session key for cross-conversation context"),
  Options.optional,
);

const renderHistory = (
  conversationId: string,
  sessionKey: Option.Option<string>,
  result: HistoryResult,
  json: boolean,
): void => {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.messages.length === 0) {
    console.log("No messages.");
    return;
  }
  if (Option.isSome(sessionKey) && result.conversationMeta) {
    const label = result.conversationMeta.name ?? result.conversationMeta.type;
    console.log(
      `Conversation: ${label} (${conversationId}) | ${result.newCount} new`,
    );
    console.log("");
  }
  for (const m of result.messages) {
    const ago = Math.max(
      0,
      Math.round((Date.now() - new Date(m.createdAt).getTime()) / 60_000),
    );
    const newMarker = m.isNew ? " *" : "";
    console.log(`  [${ago}m ago] ${m.senderName}: ${m.text}${newMarker}`);
  }
  if (result.hasMore) {
    console.log("  ... more messages available");
  }
};

const historyHandler = ({
  conversationId,
  limit,
  json,
  sessionKey,
}: {
  conversationId: string;
  limit: number;
  json: boolean;
  sessionKey: Option.Option<string>;
}): Effect.Effect<void> => {
  const params: Record<string, unknown> = { conversationId, limit };
  if (Option.isSome(sessionKey)) params.sessionKey = sessionKey.value;
  return wrap(
    request("history", params) as Effect.Effect<HistoryResult, Error>,
    (result) => {
      renderHistory(conversationId, sessionKey, result, json);
    },
  );
};

const historySubcommand = Command.make(
  "history",
  {
    conversationId: conversationIdArg,
    limit: historyLimitOption,
    json: jsonOption,
    sessionKey: sessionKeyOption,
  },
  historyHandler,
).pipe(Command.withDescription("Show message history for a conversation"));

// ─── ARCH sbd#185: new v2 subcommands (get / archive / unarchive) ──────────
//
// Stubs only — bodies are `throw new Error("not implemented")`. Full
// signatures and traceability: https://github.com/chughtapan/safer-by-default/issues/177
// (architect design doc rev 2).

import {
  rpc as transportRpc,
  runHandler as runConversationsHandler,
  type Transport,
  type TransportError,
} from "../transport.js";

/** Discriminated error union for the three v2 conversation subcommands. */
export type ConversationsCommandError =
  | TransportError
  | ConversationsInputError;

/** CLI-level input was rejected (architect stage: signature only). */
export class ConversationsInputError extends Error {
  readonly _tag = "ConversationsInputError" as const;
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** `moltzap conversations get <id>` → conversations/get; prints { conversation, participants }. */
export const conversationsGetHandler = (
  args: { readonly conversationId: string },
): Effect.Effect<void, ConversationsCommandError, Transport> =>
  Effect.gen(function* () {
    const result = yield* transportRpc<{
      conversation: unknown;
      participants: unknown;
    }>("conversations/get", { conversationId: args.conversationId });
    yield* Effect.sync(() => {
      console.log(JSON.stringify(result, null, 2));
    });
  });

/** `moltzap conversations archive <id>` → conversations/archive; prints success marker. */
export const conversationsArchiveHandler = (
  args: { readonly conversationId: string },
): Effect.Effect<void, ConversationsCommandError, Transport> =>
  Effect.gen(function* () {
    yield* transportRpc<Record<string, never>>("conversations/archive", {
      conversationId: args.conversationId,
    });
    yield* Effect.sync(() => {
      console.log(`archived: ${args.conversationId}`);
    });
  });

/** `moltzap conversations unarchive <id>` → conversations/unarchive; prints success marker. */
export const conversationsUnarchiveHandler = (
  args: { readonly conversationId: string },
): Effect.Effect<void, ConversationsCommandError, Transport> =>
  Effect.gen(function* () {
    yield* transportRpc<Record<string, never>>("conversations/unarchive", {
      conversationId: args.conversationId,
    });
    yield* Effect.sync(() => {
      console.log(`unarchived: ${args.conversationId}`);
    });
  });

// ── Command.make wrappers for the three v2 handlers ───────────────────────
const getConversationCommand = Command.make(
  "get",
  { conversationId: conversationIdArg },
  ({ conversationId }) =>
    runConversationsHandler(conversationsGetHandler({ conversationId })),
).pipe(Command.withDescription("Get a conversation and its participants"));

const archiveConversationCommand = Command.make(
  "archive",
  { conversationId: conversationIdArg },
  ({ conversationId }) =>
    runConversationsHandler(
      conversationsArchiveHandler({ conversationId }),
    ),
).pipe(Command.withDescription("Archive a conversation"));

const unarchiveConversationCommand = Command.make(
  "unarchive",
  { conversationId: conversationIdArg },
  ({ conversationId }) =>
    runConversationsHandler(
      conversationsUnarchiveHandler({ conversationId }),
    ),
).pipe(Command.withDescription("Unarchive a conversation"));

/**
 * `moltzap conversations [list|create|leave|mute|unmute|update|add-participant|remove-participant|history|get|archive|unarchive]`
 * — conversation CRUD + inspection over the local Unix socket. Default (no
 * subcommand) lists. The `get`, `archive`, `unarchive` subcommands are
 * wired by impl-staff against the handlers above (sbd#185).
 */
export const conversationsCommand = Command.make("conversations", {}, () =>
  listConversations.handler({ limit: 20, json: false }),
).pipe(
  Command.withDescription("Manage conversations"),
  Command.withSubcommands([
    listConversations,
    createConversation,
    leaveConversation,
    muteConversation,
    unmuteConversation,
    updateConversation,
    addParticipantCommand,
    removeParticipantCommand,
    historySubcommand,
    getConversationCommand,
    archiveConversationCommand,
    unarchiveConversationCommand,
  ]),
);

/** Top-level `moltzap history <conversationId>` — identical to `conversations history`. */
export const historyCommand = Command.make(
  "history",
  {
    conversationId: conversationIdArg,
    limit: historyLimitOption,
    json: jsonOption,
    sessionKey: sessionKeyOption,
  },
  historyHandler,
).pipe(Command.withDescription("Show message history for a conversation"));
