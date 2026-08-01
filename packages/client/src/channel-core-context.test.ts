import { beforeEach, expect, it, vi } from "vitest";
import { Effect } from "effect";

import {
  agent,
  buildMessage,
  type ChannelCoreFixture,
  conversation,
  createChannelCoreFixture,
  type CrossConversationEntry,
  customSetup,
  DEVS_GROUP_NAME,
  effectTest,
  type EnrichedInboundMessage,
  FIRST_TEXT,
  FIRST_VISIT_TEXT,
  flushDispatchChainEffect,
  forceResolveAgentNamePath,
  message,
  MoltZapChannelCore,
  participant,
  SECOND_TEXT,
  task,
  TestInboundHandlerError,
} from "./channel-core-test-support.js";

let fake: ChannelCoreFixture["fake"];
let service: ChannelCoreFixture["service"];
let core: ChannelCoreFixture["core"];
let inbound: EnrichedInboundMessage[];

beforeEach(() => {
  ({ fake, service, core, inbound } = createChannelCoreFixture());
});

function attachesGroupMetadataWhenConversationIsAGroup() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", {
      type: "group",
      name: DEVS_GROUP_NAME,
      participants: [
        "agent:agent-alice",
        "agent:agent-bob",
        "agent:agent-self",
      ],
    });
    fake.state.setAgentName("agent-alice", "Alice");

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    const msg = inbound[0]!;
    expect(msg.contextBlocks.groupMetadata).toEqual({
      type: "group",
      name: DEVS_GROUP_NAME,
      participants: [
        participant("agent-alice"),
        participant("agent-bob"),
        participant("agent-self"),
      ],
    });
  });
}

effectTest(
  "attaches groupMetadata when conversation is a group",
  attachesGroupMetadataWhenConversationIsAGroup,
);

function doesNOTAttachGroupMetadataForDMConversations() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", {
      type: "dm",
      name: "alice-dm",
      participants: ["agent:agent-alice", "agent:agent-self"],
    });
    fake.state.setAgentName("agent-alice", "Alice");

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    expect(inbound[0]!.contextBlocks.groupMetadata).toBeUndefined();
  });
}

effectTest(
  "does NOT attach groupMetadata for DM conversations",
  doesNOTAttachGroupMetadataForDMConversations,
);

function attachesCrossConversationEntriesWhenGetContextEntriesReturnsNonEmpty() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");

    const entries: CrossConversationEntry[] = [
      {
        conversationId: "conv-other",
        conversationName: "other-dm",
        senderName: "Bob",
        text: "hello from the other side",
        minutesAgo: 3,
        count: 1,
      },
    ];
    fake.state.setContextEntries("conv-1", entries);

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    expect(inbound[0]!.contextBlocks.crossConversation).toEqual(entries);
  });
}

effectTest(
  "attaches crossConversation entries when getContextEntries returns non-empty",
  attachesCrossConversationEntriesWhenGetContextEntriesReturnsNonEmpty,
);

function doesNOTAttachCrossConversationWhenGetContextEntriesReturnsEmpty() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    // Fixture default: returns [] for unknown convs

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    expect(inbound[0]!.contextBlocks.crossConversation).toBeUndefined();
  });
}

effectTest(
  "does NOT attach crossConversation when getContextEntries returns empty",
  doesNOTAttachCrossConversationWhenGetContextEntriesReturnsEmpty,
);

function handlesGroupsWithZeroParticipantsGracefully() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", {
      type: "group",
      name: "empty-group",
      participants: [],
    });
    fake.state.setAgentName("agent-alice", "Alice");

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    const meta = inbound[0]!.contextBlocks.groupMetadata;
    expect(meta).toBeDefined();
    expect(meta!.participants).toEqual([]);
  });
}

effectTest(
  "handles groups with zero participants gracefully",
  handlesGroupsWithZeroParticipantsGracefully,
);

function commitsContextMarkersAfterEnrichmentSoASecondInboundMessageDoesNotReSeeTheSameEntries() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    fake.state.setContextEntries("conv-1", [
      {
        conversationId: "conv-other",
        senderName: "Bob",
        text: FIRST_VISIT_TEXT,
        minutesAgo: 1,
        count: 1,
      },
    ]);

    fake.emit.message(buildMessage({ id: "msg-1" }));
    yield* flushDispatchChainEffect;
    expect(inbound[0]!.contextBlocks.crossConversation).toHaveLength(1);

    fake.emit.message(buildMessage({ id: "msg-2" }));
    yield* flushDispatchChainEffect;
    expect(inbound[1]!.contextBlocks.crossConversation).toBeUndefined();
  });
}

effectTest(
  "commits context markers after enrichment so a second inbound message does not re-see the same entries",
  commitsContextMarkersAfterEnrichmentSoASecondInboundMessageDoesNotReSeeTheSameEntries,
);

function doesNotCommitWhenThereAreNoContextEntries() {
  return Effect.gen(function* () {
    const commitSpy = vi.fn();
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    // Install a peekContextEntries that records commit calls.
    (
      fake.service as {
        peekContextEntries: (id: string) => {
          entries: CrossConversationEntry[];
          commit: () => void;
        };
      }
    ).peekContextEntries = () => ({ entries: [], commit: commitSpy });

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    expect(commitSpy).not.toHaveBeenCalled();
  });
}

effectTest(
  "does not commit when there are no context entries",
  doesNotCommitWhenThereAreNoContextEntries,
);

function attachesCrossConversationMessagesWhenPeekFullMessagesReturnsNonEmpty() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    fake.state.setFullMessages("conv-1", [
      {
        conversationId: "conv-other",
        conversationName: "other-dm",
        senderName: "Bob",
        senderId: "agent-bob",
        text: "full message text here",
        timestamp: "2026-04-13T22:00:00Z",
      },
    ]);

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    const msgs = inbound[0]!.contextBlocks.crossConversationMessages;
    expect(msgs).toHaveLength(1);
    expect(msgs![0]).toMatchObject({
      conversationId: "conv-other",
      senderName: "Bob",
      text: "full message text here",
      timestamp: "2026-04-13T22:00:00Z",
    });
  });
}

effectTest(
  "attaches crossConversationMessages when peekFullMessages returns non-empty",
  attachesCrossConversationMessagesWhenPeekFullMessagesReturnsNonEmpty,
);

function doesNOTAttachCrossConversationMessagesWhenPeekFullMessagesReturnsEmpty() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    expect(inbound[0]!.contextBlocks.crossConversationMessages).toBeUndefined();
  });
}

effectTest(
  "does NOT attach crossConversationMessages when peekFullMessages returns empty",
  doesNOTAttachCrossConversationMessagesWhenPeekFullMessagesReturnsEmpty,
);

function commitsFullMessageMarkersAfterInboundHandlerSucceeds() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    fake.state.setFullMessages("conv-1", [
      {
        conversationId: "conv-other",
        senderName: "Bob",
        senderId: "agent-bob",
        text: FIRST_TEXT,
        timestamp: "2026-04-13T22:00:00Z",
      },
    ]);

    fake.emit.message(buildMessage({ id: "msg-1" }));
    yield* flushDispatchChainEffect;
    expect(inbound[0]!.contextBlocks.crossConversationMessages).toHaveLength(1);

    fake.emit.message(buildMessage({ id: "msg-2" }));
    yield* flushDispatchChainEffect;
    expect(inbound[1]!.contextBlocks.crossConversationMessages).toBeUndefined();
  });
}

effectTest(
  "commits full message markers after inbound handler succeeds",
  commitsFullMessageMarkersAfterInboundHandlerSucceeds,
);

function delegatesToServiceSendWithConversationIdAndText() {
  return Effect.gen(function* () {
    yield* core.sendReply(
      task("task-42"),
      conversation("conv-42"),
      "hello there",
    );
    expect(fake.state.sent).toEqual([
      {
        taskId: task("task-42"),
        convId: conversation("conv-42"),
        text: "hello there",
      },
    ]);
  });
}

effectTest(
  "delegates to service.send with conversationId and text",
  delegatesToServiceSendWithConversationIdAndText,
);

function dropsRepliesLocallyAfterTheConversationIsArchived() {
  return Effect.gen(function* () {
    fake.emit.conversationArchived({ conversationId: "conv-42" });

    yield* core.sendReply(
      task("task-42"),
      conversation("conv-42"),
      "hello there",
    );

    expect(fake.state.sent).toEqual([]);
  });
}

effectTest(
  "drops replies locally after the conversation is archived",
  dropsRepliesLocallyAfterTheConversationIsArchived,
);

function resumesRepliesAfterTheConversationIsUnarchived() {
  return Effect.gen(function* () {
    fake.emit.conversationArchived({ conversationId: "conv-42" });
    fake.emit.conversationUnarchived({ conversationId: "conv-42" });

    yield* core.sendReply(
      task("task-42"),
      conversation("conv-42"),
      "hello again",
    );

    expect(fake.state.sent).toEqual([
      {
        taskId: task("task-42"),
        convId: conversation("conv-42"),
        text: "hello again",
      },
    ]);
  });
}

effectTest(
  "resumes replies after the conversation is unarchived",
  resumesRepliesAfterTheConversationIsUnarchived,
);

function returnsTheSameShapeAsTheInstanceHandlerPath() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", {
      type: "group",
      name: DEVS_GROUP_NAME,
      participants: ["agent:agent-alice", "agent:agent-self"],
    });
    fake.state.setAgentName("agent-alice", "Alice");
    fake.state.setContextEntries("conv-1", [
      {
        conversationId: "conv-other",
        senderName: "Bob",
        text: "bonjour",
        minutesAgo: 1,
        count: 1,
      },
    ]);

    const msg = buildMessage({
      id: "msg-static",
      conversationId: "conv-1",
      parts: [{ type: "text", text: "static enrichment" }],
    });

    const { enriched: staticResult, commitContext } =
      yield* MoltZapChannelCore.enrichMessage(service, task("task-1"), msg);

    expect(staticResult).toMatchObject({
      id: message("msg-static"),
      conversationId: conversation("conv-1"),
      sender: { id: agent("agent-alice"), name: "Alice" },
      text: "static enrichment",
      isFromMe: false,
    });
    expect(staticResult.contextBlocks.groupMetadata?.name).toBe(
      DEVS_GROUP_NAME,
    );
    expect(staticResult.contextBlocks.crossConversation).toHaveLength(1);
    expect(commitContext).toBeTypeOf("function");
  });
}

effectTest(
  "returns the same shape as the instance handler path",
  returnsTheSameShapeAsTheInstanceHandlerPath,
);

function staticHelperToleratesResolveAgentNameThrowingDisconnectedService() {
  return Effect.gen(function* () {
    const { fake } = customSetup();
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    forceResolveAgentNamePath(fake);
    fake.state.setResolveAgentNameFailure(
      "agent-unknown",
      new Error("Not connected"),
    );

    const { enriched: result } = yield* MoltZapChannelCore.enrichMessage(
      fake.service,
      task("task-unknown"),
      buildMessage({ senderId: "agent-unknown" }),
    );

    expect(result.sender.name).toBe(agent("agent-unknown"));
  });
}

effectTest(
  "static helper tolerates resolveAgentName throwing (disconnected service)",
  staticHelperToleratesResolveAgentNameThrowingDisconnectedService,
);

function disconnectRunningHandlersContinueAfterOneThrowsLoggerErrorSeesDisconnectHandlerThrew() {
  return Effect.gen(function* () {
    const { fake, core } = customSetup();
    const recorded: string[] = [];
    core.onDisconnect(() => {
      throw new Error("first disconnect boom");
    });
    core.onDisconnect(() => {
      recorded.push(SECOND_TEXT);
    });

    yield* core.connect();
    fake.emit.disconnect();

    expect(recorded).toEqual([SECOND_TEXT]);
  });
}

effectTest(
  "disconnect: running handlers continue after one throws",
  disconnectRunningHandlersContinueAfterOneThrowsLoggerErrorSeesDisconnectHandlerThrew,
);

it("reconnect: running handlers continue after one throws", () => {
  const { fake, core } = customSetup();
  const recorded: string[] = [];
  core.onReconnect(() => {
    throw new Error("first reconnect boom");
  });
  core.onReconnect(() => {
    recorded.push(SECOND_TEXT);
  });

  fake.emit.reconnect();

  expect(recorded).toEqual([SECOND_TEXT]);
});

function leavesMarkersUnadvancedWhenTheHandlerSEffectFailsSoTheNextMessageReSeesTheSameContextEntries() {
  return Effect.gen(function* () {
    const { fake, core } = customSetup();
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");
    fake.state.setContextEntries("conv-1", [
      {
        conversationId: "conv-other",
        senderName: "Bob",
        text: FIRST_VISIT_TEXT,
        minutesAgo: 1,
        count: 1,
      },
    ]);

    let shouldFail = true;
    const received: EnrichedInboundMessage[] = [];
    core.onInbound((m) =>
      Effect.gen(function* () {
        received.push(m);
        if (shouldFail) {
          yield* Effect.fail(
            new TestInboundHandlerError({ message: "inbound handler boom" }),
          );
        }
      }),
    );

    // First message: handler fails after capturing the enriched payload.
    // commitContext() must NOT run, so the fake's contextEntries remain.
    fake.emit.message(buildMessage({ id: "msg-1" }));
    yield* flushDispatchChainEffect;
    expect(received[0]!.contextBlocks.crossConversation).toHaveLength(1);

    // Second message: handler succeeds. Because the first message didn't
    // commit, the fake still returns the same entries.
    shouldFail = false;
    fake.emit.message(buildMessage({ id: "msg-2" }));
    yield* flushDispatchChainEffect;
    expect(received[1]!.contextBlocks.crossConversation).toHaveLength(1);
    expect(received[1]!.contextBlocks.crossConversation![0]!.text).toBe(
      FIRST_VISIT_TEXT,
    );
  });
}

effectTest(
  "leaves markers unadvanced when the handler's Effect fails so the next message re-sees the same context entries",
  leavesMarkersUnadvancedWhenTheHandlerSEffectFailsSoTheNextMessageReSeesTheSameContextEntries,
);
