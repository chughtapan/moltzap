import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ConversationId } from "@moltzap/protocol/conversation";
import { agentsSearch } from "@moltzap/protocol/identity";
import { messagesRead, type Message } from "@moltzap/protocol/message";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import {
  reconstructHarnessContext,
  type ContextProjectionReadPlane,
} from "./harness-context-projection.js";
import {
  decodeHarnessSearchConversationsResult,
  type ConversationWithParticipants,
  type HarnessTurnEvent,
} from "./harness/runtime.js";
import { NonAdvancingCursorError } from "./pagination.js";

const TARGET = conversationId("00000000-0000-4000-8000-000000000001");
const SOURCE = conversationId("00000000-0000-4000-8000-000000000002");
const OTHER_TARGET = conversationId("00000000-0000-4000-8000-000000000003");
const SENDER = agentId("00000000-0000-4000-8000-000000000004");
const CREATED_BY = agentId("00000000-0000-4000-8000-000000000005");
const AGENT_PAGE_CURSOR = "agent-page-2";
const CONVERSATION_PAGE_CURSOR = "conversation-page-2";
const SOURCE_PAGE_CURSOR = "source-page-2";
const SOURCE_CHECKPOINT = "source-checkpoint";

const conversation = (id: ConversationId): ConversationWithParticipants => ({
  id,
  createdBy: CREATED_BY,
  participants: [CREATED_BY, SENDER],
  createdAt: "2026-08-03T12:00:00.000Z",
  updatedAt: "2026-08-03T12:00:00.000Z",
});

const message = (
  id: string,
  sourceConversationId: ConversationId,
  createdAt: string,
): Message => ({
  id: messageId(id),
  conversationId: sourceConversationId,
  senderId: SENDER,
  parts: [{ type: "text", text: id }],
  createdAt,
});

const decodeSearchPage = (value: unknown) =>
  Effect.runSync(decodeHarnessSearchConversationsResult(value));
const decodeAgentSearchPage = Schema.decodeUnknownSync(
  agentsSearch.resultSchema,
);
const decodeReadPage = Schema.decodeUnknownSync(messagesRead.resultSchema);
const decodeStoredCheckpointMap = Schema.decodeUnknown(
  Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.String })),
);

const storedCheckpoints = (targetConversationId: ConversationId) =>
  KeyValueStore.KeyValueStore.pipe(
    Effect.flatMap((store) => store.get(targetConversationId)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.dieMessage("expected stored checkpoints"),
        onSome: decodeStoredCheckpointMap,
      }),
    ),
  );

const liveEvent = (liveMessage: Message): HarnessTurnEvent => ({
  messages: [liveMessage],
});

const TARGET_MESSAGE = message(
  "00000000-0000-4000-8000-000000000006",
  TARGET,
  "2026-08-03T12:00:03.000Z",
);
const EARLY_CROSS_MESSAGE = message(
  "00000000-0000-4000-8000-000000000007",
  SOURCE,
  "2026-08-03T12:00:01.000Z",
);
const LATE_CROSS_MESSAGE = message(
  "00000000-0000-4000-8000-000000000008",
  SOURCE,
  "2026-08-03T12:00:02.000Z",
);

const FIRST_AGENT_PAGE = decodeAgentSearchPage({
  agents: [{ id: SENDER, name: "sender-agent", status: "active" }],
  nextCursor: AGENT_PAGE_CURSOR,
});
const SECOND_AGENT_PAGE = decodeAgentSearchPage({
  agents: [{ id: CREATED_BY, name: "creator-agent", status: "active" }],
});

type AgentSearchParams = Parameters<
  ContextProjectionReadPlane<never>["searchAgents"]
>[0];
type SearchParams = Parameters<
  ContextProjectionReadPlane<never>["searchConversations"]
>[0];
type ReadParams = Parameters<
  ContextProjectionReadPlane<never>["readConversation"]
>[0];

const paginatedSearch = (params: SearchParams) =>
  Effect.succeed(
    params.cursor === undefined
      ? decodeSearchPage({
          conversations: [conversation(TARGET)],
          nextCursor: CONVERSATION_PAGE_CURSOR,
        })
      : decodeSearchPage({ conversations: [conversation(SOURCE)] }),
  );

const paginatedAgentSearch = (params: AgentSearchParams) =>
  Effect.succeed(
    params.cursor === undefined ? FIRST_AGENT_PAGE : SECOND_AGENT_PAGE,
  );

const emptyAgentSearch: ContextProjectionReadPlane<never>["searchAgents"] =
  () => Effect.succeed(decodeAgentSearchPage({ agents: [] }));

const paginatedRead = (params: ReadParams) => {
  if (params.conversationId === TARGET) {
    return Effect.dieMessage("current-conversation history must not be read");
  }
  return Effect.succeed(
    params.cursor === undefined
      ? decodeReadPage({
          messages: [EARLY_CROSS_MESSAGE],
          checkpoint: SOURCE_CHECKPOINT,
          nextCursor: SOURCE_PAGE_CURSOR,
        })
      : decodeReadPage({
          messages: [LATE_CROSS_MESSAGE],
          checkpoint: SOURCE_CHECKPOINT,
        }),
  );
};

const makePaginatedReadPlane = () => {
  const searchAgents = vi.fn(paginatedAgentSearch);
  const searchConversations = vi.fn(paginatedSearch);
  const readConversation = vi.fn(paginatedRead);
  const readPlane = {
    searchAgents,
    searchConversations,
    readConversation,
  } satisfies ContextProjectionReadPlane<never>;
  return { readPlane, readConversation, searchAgents, searchConversations };
};

const reconstructsPaginatedContext = () => {
  const { readPlane, readConversation, searchAgents, searchConversations } =
    makePaginatedReadPlane();

  return Effect.gen(function* () {
    const context = yield* reconstructHarnessContext(
      readPlane,
      liveEvent(TARGET_MESSAGE),
    );
    const persisted = yield* storedCheckpoints(TARGET);

    expect(context.conversationId).toBe(TARGET);
    expect(context.agents).toEqual([
      ...FIRST_AGENT_PAGE.agents,
      ...SECOND_AGENT_PAGE.agents,
    ]);
    expect(context.currentMessages).toEqual([TARGET_MESSAGE]);
    expect(context.crossConversationMessages).toEqual([
      EARLY_CROSS_MESSAGE,
      LATE_CROSS_MESSAGE,
    ]);
    expect(persisted).toEqual({
      [SOURCE]: SOURCE_CHECKPOINT,
    });
    expect(Object.values(persisted)).not.toContain(CONVERSATION_PAGE_CURSOR);
    expect(Object.values(persisted)).not.toContain(SOURCE_PAGE_CURSOR);
    expect(searchAgents).toHaveBeenNthCalledWith(1, {});
    expect(searchAgents).toHaveBeenNthCalledWith(2, {
      cursor: AGENT_PAGE_CURSOR,
    });
    expect(searchConversations).toHaveBeenNthCalledWith(1, {});
    expect(searchConversations).toHaveBeenNthCalledWith(2, {
      cursor: CONVERSATION_PAGE_CURSOR,
    });
    expect(readConversation).toHaveBeenCalledWith({
      conversationId: SOURCE,
    });
    expect(readConversation).toHaveBeenCalledWith({
      conversationId: SOURCE,
      cursor: SOURCE_PAGE_CURSOR,
    });
    expect(readConversation).not.toHaveBeenCalledWith({
      conversationId: TARGET,
    });
  }).pipe(Effect.provide(KeyValueStore.layerMemory));
};

const FIRST_LIVE = message(
  "00000000-0000-4000-8000-000000000009",
  TARGET,
  "2026-08-03T12:00:00.000Z",
);
const SECOND_LIVE = message(
  "00000000-0000-4000-8000-000000000010",
  OTHER_TARGET,
  "2026-08-03T12:00:01.000Z",
);

const makeIndependentReadPlane = () => {
  const searchConversations: ContextProjectionReadPlane<never>["searchConversations"] =
    () =>
      Effect.succeed(
        decodeSearchPage({
          conversations: [
            conversation(TARGET),
            conversation(SOURCE),
            conversation(OTHER_TARGET),
          ],
        }),
      );
  const readConversation = vi.fn(
    (
      params: Parameters<
        ContextProjectionReadPlane<never>["readConversation"]
      >[0],
    ) =>
      Effect.succeed(
        decodeReadPage({
          messages: [],
          checkpoint: `${params.conversationId}-${params.checkpoint ?? "initial"}`,
        }),
      ),
  );
  return {
    searchAgents: emptyAgentSearch,
    searchConversations,
    readConversation,
  } satisfies ContextProjectionReadPlane<never>;
};

const keepsTargetSourcePositionsIndependent = () => {
  const readPlane = makeIndependentReadPlane();

  return Effect.gen(function* () {
    yield* reconstructHarnessContext(readPlane, liveEvent(FIRST_LIVE));
    yield* reconstructHarnessContext(readPlane, liveEvent(SECOND_LIVE));
    const first = yield* storedCheckpoints(TARGET);
    const second = yield* storedCheckpoints(OTHER_TARGET);

    expect(first).toEqual({
      [SOURCE]: `${SOURCE}-initial`,
      [OTHER_TARGET]: `${OTHER_TARGET}-initial`,
    });
    expect(second).toEqual({
      [TARGET]: `${TARGET}-initial`,
      [SOURCE]: `${SOURCE}-initial`,
    });
    expect(readPlane.readConversation).toHaveBeenCalledWith({
      conversationId: SOURCE,
    });
  }).pipe(Effect.provide(KeyValueStore.layerMemory));
};

const searchTargetAndSource = () =>
  Effect.succeed(
    decodeSearchPage({
      conversations: [conversation(TARGET), conversation(SOURCE)],
    }),
  );

const makeRestartReadPlane = (firstCrossMessage: Message) => {
  const searchConversations = searchTargetAndSource;
  const readConversation = vi.fn((params: ReadParams) =>
    Effect.succeed(
      params.checkpoint === undefined
        ? decodeReadPage({
            messages: [firstCrossMessage],
            checkpoint: "first-stable-checkpoint",
          })
        : decodeReadPage({
            messages: [],
            checkpoint: "second-stable-checkpoint",
          }),
    ),
  );
  const readPlane = {
    searchAgents: emptyAgentSearch,
    searchConversations,
    readConversation,
  } satisfies ContextProjectionReadPlane<never>;
  return { readConversation, readPlane };
};

const reusesOnlyStableCheckpointsForLaterObservation = () => {
  const firstLive = message(
    "00000000-0000-4000-8000-000000000011",
    TARGET,
    "2026-08-03T12:00:00.000Z",
  );
  const laterLive = message(
    "00000000-0000-4000-8000-000000000012",
    TARGET,
    "2026-08-03T12:00:01.000Z",
  );
  const firstCrossMessage = message(
    "00000000-0000-4000-8000-000000000013",
    SOURCE,
    "2026-08-03T11:59:59.000Z",
  );
  const { readConversation, readPlane } =
    makeRestartReadPlane(firstCrossMessage);

  return Effect.gen(function* () {
    const first = yield* reconstructHarnessContext(
      readPlane,
      liveEvent(firstLive),
    );
    const later = yield* reconstructHarnessContext(
      readPlane,
      liveEvent(laterLive),
    );

    expect(first.crossConversationMessages).toEqual([firstCrossMessage]);
    expect(later.currentMessages).toEqual([laterLive]);
    expect(later.crossConversationMessages).toEqual([]);
    expect(readConversation).toHaveBeenLastCalledWith({
      conversationId: SOURCE,
      checkpoint: "first-stable-checkpoint",
    });
    expect(yield* storedCheckpoints(TARGET)).toEqual({
      [SOURCE]: "second-stable-checkpoint",
    });
  }).pipe(Effect.provide(KeyValueStore.layerMemory));
};

const cyclicSearchReadPlane = {
  searchAgents: () => Effect.dieMessage("conversation search must finish"),
  searchConversations: () =>
    Effect.succeed(
      decodeSearchPage({
        conversations: [conversation(TARGET)],
        nextCursor: CONVERSATION_PAGE_CURSOR,
      }),
    ),
  readConversation: () => Effect.dieMessage("search must finish before reads"),
} satisfies ContextProjectionReadPlane<never>;

const rejectsCyclicSearchWithoutCheckpointing = () =>
  Effect.gen(function* () {
    const error = yield* reconstructHarnessContext(
      cyclicSearchReadPlane,
      liveEvent(TARGET_MESSAGE),
    ).pipe(Effect.flip);
    const store = yield* KeyValueStore.KeyValueStore;

    expect(error).toBeInstanceOf(NonAdvancingCursorError);
    expect(Option.isNone(yield* store.get(TARGET))).toBe(true);
  }).pipe(Effect.provide(KeyValueStore.layerMemory));

const PRIOR_SOURCE_CHECKPOINT = "prior-source-checkpoint";
const MID_READ_CURSOR = "mid-read-cursor";
const READ_FAILURE = "read failed";

const makeFailingReadPlane = () => {
  const searchConversations = searchTargetAndSource;
  const readConversation = vi.fn((params: ReadParams) =>
    params.cursor === undefined
      ? Effect.succeed(
          decodeReadPage({
            messages: [EARLY_CROSS_MESSAGE],
            checkpoint: SOURCE_CHECKPOINT,
            nextCursor: MID_READ_CURSOR,
          }),
        )
      : Effect.fail(READ_FAILURE),
  );
  return {
    searchAgents: () => Effect.dieMessage("history reads must finish"),
    searchConversations,
    readConversation,
  } satisfies ContextProjectionReadPlane<string>;
};

const preservesPriorCheckpointWhenReadFails = () => {
  const readPlane = makeFailingReadPlane();
  return Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    yield* store.set(
      TARGET,
      JSON.stringify({ [SOURCE]: PRIOR_SOURCE_CHECKPOINT }),
    );

    yield* reconstructHarnessContext(readPlane, liveEvent(TARGET_MESSAGE)).pipe(
      Effect.flip,
    );

    expect(yield* storedCheckpoints(TARGET)).toEqual({
      [SOURCE]: PRIOR_SOURCE_CHECKPOINT,
    });
    expect(readPlane.readConversation).toHaveBeenNthCalledWith(1, {
      conversationId: SOURCE,
      checkpoint: PRIOR_SOURCE_CHECKPOINT,
    });
  }).pipe(Effect.provide(KeyValueStore.layerMemory));
};

const cyclicAgentSearch = vi.fn(() =>
  Effect.succeed(
    decodeAgentSearchPage({
      agents: [],
      nextCursor: AGENT_PAGE_CURSOR,
    }),
  ),
);

const cyclicAgentReadPlane = {
  searchAgents: cyclicAgentSearch,
  searchConversations: () =>
    Effect.succeed(decodeSearchPage({ conversations: [conversation(TARGET)] })),
  readConversation: () => Effect.dieMessage("target history is not read"),
} satisfies ContextProjectionReadPlane<never>;

const rejectsCyclicAgentSearchWithoutCheckpointing = () =>
  Effect.gen(function* () {
    const error = yield* reconstructHarnessContext(
      cyclicAgentReadPlane,
      liveEvent(TARGET_MESSAGE),
    ).pipe(Effect.flip);
    const store = yield* KeyValueStore.KeyValueStore;

    expect(error).toBeInstanceOf(NonAdvancingCursorError);
    expect(error).toMatchObject({ method: agentsSearch.name });
    expect(cyclicAgentSearch).toHaveBeenNthCalledWith(1, {});
    expect(cyclicAgentSearch).toHaveBeenNthCalledWith(2, {
      cursor: AGENT_PAGE_CURSOR,
    });
    expect(Option.isNone(yield* store.get(TARGET))).toBe(true);
  }).pipe(Effect.provide(KeyValueStore.layerMemory));

const AGENT_SEARCH_FAILURE = "agent search failed";

const makeFailingAgentSearchReadPlane = () => {
  const readConversation = vi.fn(() =>
    Effect.succeed(
      decodeReadPage({
        messages: [],
        checkpoint: SOURCE_CHECKPOINT,
      }),
    ),
  );
  return {
    searchAgents: () => Effect.fail(AGENT_SEARCH_FAILURE),
    searchConversations: searchTargetAndSource,
    readConversation,
  } satisfies ContextProjectionReadPlane<string>;
};

const preservesPriorCheckpointWhenAgentSearchFails = () => {
  const readPlane = makeFailingAgentSearchReadPlane();
  return Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    yield* store.set(
      TARGET,
      JSON.stringify({ [SOURCE]: PRIOR_SOURCE_CHECKPOINT }),
    );

    const error = yield* reconstructHarnessContext(
      readPlane,
      liveEvent(TARGET_MESSAGE),
    ).pipe(Effect.flip);

    expect(error).toBe(AGENT_SEARCH_FAILURE);
    expect(readPlane.readConversation).toHaveBeenCalledWith({
      conversationId: SOURCE,
      checkpoint: PRIOR_SOURCE_CHECKPOINT,
    });
    expect(yield* storedCheckpoints(TARGET)).toEqual({
      [SOURCE]: PRIOR_SOURCE_CHECKPOINT,
    });
  }).pipe(Effect.provide(KeyValueStore.layerMemory));
};

// @agent-code-guard/regression-only: these examples pin target/source persistence and keep temporary directory and history cursors out of durable client state.
describe("Harness context reconstruction", () => {
  it("drains agent, conversation, and history pages before persisting checkpoints", () =>
    Effect.runPromise(reconstructsPaginatedContext()));
  it("keeps checkpoint maps independent for each target conversation", () =>
    Effect.runPromise(keepsTargetSourcePositionsIndependent()));
  it("reuses stable checkpoints while a later live observation still emits", () =>
    Effect.runPromise(reusesOnlyStableCheckpointsForLaterObservation()));
  it("rejects a cyclic search cursor without storing a checkpoint", () =>
    Effect.runPromise(rejectsCyclicSearchWithoutCheckpointing()));
  it("rejects a cyclic agent cursor without storing a checkpoint", () =>
    Effect.runPromise(rejectsCyclicAgentSearchWithoutCheckpointing()));
  it("leaves a prior checkpoint unchanged when a page read fails", () =>
    Effect.runPromise(preservesPriorCheckpointWhenReadFails()));
  it("leaves a prior checkpoint unchanged when agent search fails", () =>
    Effect.runPromise(preservesPriorCheckpointWhenAgentSearchFails()));
});
