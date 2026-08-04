import * as KeyValueStore from "@effect/platform/KeyValueStore";
import type * as PlatformError from "@effect/platform/Error";
import { Effect, Option, Schema, type ParseResult } from "effect";
import {
  conversationId,
  conversationSearch,
  type Conversation,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import {
  conversationCheckpoint,
  messagesRead,
  type ConversationCheckpoint,
  type Message,
} from "@moltzap/protocol/message";
import type { ParamsOf, ResultOf } from "@moltzap/protocol/rpc";
import type { HarnessTurnEvent } from "./harness/runtime.js";
import { NonAdvancingCursorError } from "./pagination.js";

const checkpointMapSchema = Schema.Record({
  key: conversationId,
  value: conversationCheckpoint,
});

type CheckpointMap = Schema.Schema.Type<typeof checkpointMapSchema>;
type ConversationSearchCursor = NonNullable<
  ResultOf<typeof conversationSearch>["nextCursor"]
>;
type ConversationReadCursor = NonNullable<
  ResultOf<typeof messagesRead>["nextCursor"]
>;

/** Package-private MCP read capabilities used for presentation recovery. */
export interface ContextProjectionReadPlane<E> {
  readonly searchConversations: (
    params: ParamsOf<typeof conversationSearch>,
  ) => Effect.Effect<ResultOf<typeof conversationSearch>, E>;
  readonly readConversation: (
    params: ParamsOf<typeof messagesRead>,
  ) => Effect.Effect<ResultOf<typeof messagesRead>, E>;
}

/** Raw production context reconstructed for one live replyable observation. */
export interface ReconstructedHarnessContext {
  readonly conversationId: ConversationId;
  readonly conversations: readonly Conversation[];
  readonly currentMessages: readonly Message[];
  readonly crossConversationMessages: readonly Message[];
}

interface ConversationDelta {
  readonly conversationId: ConversationId;
  readonly messages: readonly Message[];
  readonly checkpoint: ConversationCheckpoint;
}

const repeatedCursor = (method: string) =>
  new NonAdvancingCursorError({ method });

const acceptNextCursor = <Cursor extends string>(
  seen: Set<Cursor>,
  method: string,
  nextCursor?: Cursor,
): Effect.Effect<Cursor | undefined, NonAdvancingCursorError> => {
  if (nextCursor === undefined) {
    return Effect.succeed(undefined);
  }
  if (seen.has(nextCursor)) {
    return Effect.fail(repeatedCursor(method));
  }
  seen.add(nextCursor);
  return Effect.succeed(nextCursor);
};

const drainConversationSearch = <E>(
  readPlane: ContextProjectionReadPlane<E>,
): Effect.Effect<readonly Conversation[], E | NonAdvancingCursorError> =>
  Effect.gen(function* () {
    const conversations: Conversation[] = [];
    const seenCursors = new Set<ConversationSearchCursor>();
    let cursor: ConversationSearchCursor | undefined;
    do {
      const page = yield* readPlane.searchConversations(
        cursor === undefined ? {} : { cursor },
      );
      conversations.push(...page.conversations);
      cursor = yield* acceptNextCursor(
        seenCursors,
        conversationSearch.name,
        page.nextCursor,
      );
    } while (cursor !== undefined);
    return conversations;
  }).pipe(Effect.withSpan("HarnessContextProjection.searchConversations"));

const drainConversationRead = <E>(
  readPlane: ContextProjectionReadPlane<E>,
  conversationId: ConversationId,
  checkpoint?: ConversationCheckpoint,
): Effect.Effect<ConversationDelta, E | NonAdvancingCursorError> =>
  Effect.gen(function* () {
    const messages: Message[] = [];
    const seenCursors = new Set<ConversationReadCursor>();
    let cursor: ConversationReadCursor | undefined;
    let nextCheckpoint: ConversationCheckpoint | undefined;
    do {
      const page = yield* readPlane.readConversation(
        cursor === undefined
          ? {
              conversationId,
              ...(checkpoint === undefined ? {} : { checkpoint }),
            }
          : { conversationId, cursor },
      );
      messages.push(...page.messages);
      nextCheckpoint = page.checkpoint;
      cursor = yield* acceptNextCursor(
        seenCursors,
        messagesRead.name,
        page.nextCursor,
      );
    } while (cursor !== undefined);

    if (nextCheckpoint === undefined) {
      return yield* Effect.dieMessage(
        "read_conversation completed without a stable checkpoint",
      );
    }
    return { conversationId, messages, checkpoint: nextCheckpoint };
  }).pipe(
    Effect.withSpan("HarnessContextProjection.readConversation", {
      attributes: { conversationId },
    }),
  );

/**
 * Current content comes only from the live batch. Reading its conversation
 * here could race ahead and attach a later message to the wrong reply turn.
 * @param conversations Conversations visible to the active agent.
 * @param targetConversationId Conversation carrying the live batch.
 * @returns Conversation identifiers eligible for cross-context recovery.
 */
const sourceConversationIds = (
  conversations: readonly Conversation[],
  targetConversationId: ConversationId,
): readonly ConversationId[] =>
  conversations
    .map((conversation) => conversation.id)
    .filter((conversationId) => conversationId !== targetConversationId);

const chronologicalCrossMessages = (
  deltas: readonly ConversationDelta[],
  targetConversationId: ConversationId,
): readonly Message[] =>
  deltas
    .filter((delta) => delta.conversationId !== targetConversationId)
    .flatMap((delta) => delta.messages)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

const checkpointMapAfter = (
  priorCheckpoints: CheckpointMap,
  deltas: readonly ConversationDelta[],
): CheckpointMap => {
  let nextCheckpoints = priorCheckpoints;
  for (const delta of deltas) {
    nextCheckpoints = {
      ...nextCheckpoints,
      [delta.conversationId]: delta.checkpoint,
    };
  }
  return nextCheckpoints;
};

const contextFrom = (
  event: HarnessTurnEvent,
  conversations: readonly Conversation[],
  deltas: readonly ConversationDelta[],
): ReconstructedHarnessContext => {
  const conversationId = event.messages[0].conversationId;
  return {
    conversationId,
    conversations,
    currentMessages: event.messages,
    crossConversationMessages: chronologicalCrossMessages(
      deltas,
      conversationId,
    ),
  };
};

/**
 * Reconstructs cross-conversation presentation deltas only when a live
 * observation supplies current content and reply authority. The provided
 * key-value store is scoped to one active agent; target ConversationIds key
 * source-checkpoint maps within that scope.
 *
 * @param readPlane Typed MCP search and history readers.
 * @param event Live production observation that permits one runtime turn.
 * @returns Current and cross-conversation raw context for that observation.
 */
export const reconstructHarnessContext = <E>(
  readPlane: ContextProjectionReadPlane<E>,
  event: HarnessTurnEvent,
): Effect.Effect<
  ReconstructedHarnessContext,
  | E
  | NonAdvancingCursorError
  | PlatformError.PlatformError
  | ParseResult.ParseError,
  KeyValueStore.KeyValueStore
> =>
  Effect.gen(function* () {
    const targetConversationId = event.messages[0].conversationId;
    const keyValueStore = yield* KeyValueStore.KeyValueStore;
    const checkpoints = keyValueStore.forSchema(checkpointMapSchema);
    const priorCheckpoints = Option.getOrElse(
      yield* checkpoints.get(targetConversationId),
      (): CheckpointMap => ({}),
    );
    const conversations = yield* drainConversationSearch(readPlane);
    const deltas = yield* Effect.forEach(
      sourceConversationIds(conversations, targetConversationId),
      (sourceConversationId) =>
        drainConversationRead(
          readPlane,
          sourceConversationId,
          priorCheckpoints[sourceConversationId],
        ),
      { concurrency: 1 },
    );
    const context = contextFrom(event, conversations, deltas);
    yield* checkpoints.set(
      targetConversationId,
      checkpointMapAfter(priorCheckpoints, deltas),
    );
    return context;
  }).pipe(Effect.withSpan("reconstructHarnessContext"));
