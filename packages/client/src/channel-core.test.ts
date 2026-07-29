import { beforeEach, expect, it, vi } from "vitest";
import { Effect } from "effect";

import {
  ALICE_CACHED_NAME,
  ALICE_RESOLVED_NAME,
  CAPTION_TEXT,
  MULTILINE_TEXT,
  TestInboundHandlerError,
  agent,
  buildMessage,
  conversation,
  createChannelCoreFixture,
  customSetup,
  effectTest,
  flushDispatchChainEffect,
  forceResolveAgentNamePath,
  message,
  type ChannelCoreFixture,
  type EnrichedInboundMessage,
  type Message,
} from "./channel-core-test-support.js";

let fake: ChannelCoreFixture["fake"];
let core: ChannelCoreFixture["core"];
let inbound: EnrichedInboundMessage[];

beforeEach(() => {
  ({ fake, core, inbound } = createChannelCoreFixture());
});

function connectDelegatesToServiceAndSetsConnected() {
  return Effect.gen(function* () {
    expect(core.isConnected()).toBe(false);
    yield* core.connect();
    expect(fake.state.connectCalls.count).toBe(1);
    expect(core.isConnected()).toBe(true);
  });
}

it("connect() delegates to service and sets connected", () =>
  Effect.runPromise(connectDelegatesToServiceAndSetsConnected()));

function disconnectClosesTheServiceAndClearsTheConnectedFlag() {
  return Effect.gen(function* () {
    yield* core.connect();
    yield* core.disconnect();
    expect(fake.state.closeCalls.count).toBe(1);
    expect(core.isConnected()).toBe(false);
  });
}

effectTest(
  "disconnect() closes the service and clears the connected flag",
  disconnectClosesTheServiceAndClearsTheConnectedFlag,
);

function disconnectEventFromTheServiceClearsTheConnectedFlag() {
  return Effect.gen(function* () {
    yield* core.connect();
    fake.emit.disconnect();
    expect(core.isConnected()).toBe(false);
  });
}

effectTest(
  "disconnect event from the service clears the connected flag",
  disconnectEventFromTheServiceClearsTheConnectedFlag,
);

function onDisconnectHandlersFireOnDisconnectEvent() {
  return Effect.gen(function* () {
    const spy = vi.fn();
    core.onDisconnect(spy);
    yield* core.connect();
    fake.emit.disconnect();
    expect(spy).toHaveBeenCalledOnce();
  });
}

effectTest(
  "onDisconnect handlers fire on disconnect event",
  onDisconnectHandlersFireOnDisconnectEvent,
);

function mapsAMoltZapMessageToEnrichedInboundMessage() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", {
      type: "dm",
      name: "alice-dm",
      participants: ["agent:agent-alice", "agent:agent-self"],
    });
    fake.state.setAgentName("agent-alice", "Alice");

    fake.emit.message(
      buildMessage({
        id: "msg-abc",
        conversationId: "conv-1",
        senderId: "agent-alice",
        parts: [{ type: "text", text: "hi there" }],
        createdAt: "2026-04-10T13:00:00.000Z",
      }),
    );

    yield* flushDispatchChainEffect;

    expect(inbound).toHaveLength(1);
    const enriched = inbound[0]!;
    expect(enriched).toMatchObject({
      id: message("msg-abc"),
      conversationId: conversation("conv-1"),
      sender: { id: agent("agent-alice"), name: "Alice" },
      text: "hi there",
      isFromMe: false,
      createdAt: "2026-04-10T13:00:00.000Z",
    });
    expect(enriched.conversationMeta).toMatchObject({
      type: "dm",
      name: "alice-dm",
    });
  });
}

effectTest(
  "maps a MoltZap Message to EnrichedInboundMessage",
  mapsAMoltZapMessageToEnrichedInboundMessage,
);

function resolvesSenderNameFromGetAgentNameCacheWhenPresent() {
  return Effect.gen(function* () {
    fake.state.setAgentName("agent-alice", ALICE_CACHED_NAME);
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    expect(inbound[0]!.sender.name).toBe(ALICE_CACHED_NAME);
    expect(fake.state.resolveAgentNameCallCount("agent-alice")).toBe(0);
  });
}

effectTest(
  "resolves sender name from getAgentName cache when present",
  resolvesSenderNameFromGetAgentNameCacheWhenPresent,
);

function fallsBackToResolveAgentNameWhenGetAgentNameReturnsUndefined() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    forceResolveAgentNamePath(fake);
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", ALICE_RESOLVED_NAME);

    fake.emit.message(buildMessage());
    yield* flushDispatchChainEffect;

    expect(received[0]!.sender.name).toBe(ALICE_RESOLVED_NAME);
    expect(fake.state.resolveAgentNameCallCount("agent-alice")).toBe(1);
  });
}

effectTest(
  "falls back to resolveAgentName when getAgentName returns undefined",
  fallsBackToResolveAgentNameWhenGetAgentNameReturnsUndefined,
);

function fallsBackToSenderIdWhenBothNameLookupsFail() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    forceResolveAgentNamePath(fake);
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });

    fake.emit.message(buildMessage({ senderId: "agent-unknown" }));
    yield* flushDispatchChainEffect;

    expect(received[0]!.sender.name).toBe(agent("agent-unknown"));
  });
}

effectTest(
  "falls back to sender.id when both name lookups fail",
  fallsBackToSenderIdWhenBothNameLookupsFail,
);

function swallowsResolveAgentNameErrorsAndFallsBackToSenderId() {
  return Effect.gen(function* () {
    const { fake, received } = customSetup();
    forceResolveAgentNamePath(fake);
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setResolveAgentNameFailure(
      "agent-broken",
      new Error("network down"),
    );

    fake.emit.message(buildMessage({ senderId: "agent-broken" }));
    yield* flushDispatchChainEffect;

    expect(received[0]!.sender.name).toBe(agent("agent-broken"));
  });
}

effectTest(
  "swallows resolveAgentName errors and falls back to sender.id",
  swallowsResolveAgentNameErrorsAndFallsBackToSenderId,
);

function concatenatesMultiTextPartMessagesWithNewlines() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");

    fake.emit.message(
      buildMessage({
        parts: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      }),
    );
    yield* flushDispatchChainEffect;

    expect(inbound[0]!.text).toBe(MULTILINE_TEXT);
  });
}

effectTest(
  "concatenates multi-text-part messages with newlines",
  concatenatesMultiTextPartMessagesWithNewlines,
);

function ignoresNonTextPartsWhenBuildingText() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");

    fake.emit.message(
      buildMessage({
        parts: [
          { type: "text", text: CAPTION_TEXT },
          { type: "image", url: "https://example.com/pic.png" },
        ] as Message["parts"],
      }),
    );
    yield* flushDispatchChainEffect;

    expect(inbound[0]!.text).toBe(CAPTION_TEXT);
  });
}

effectTest(
  "ignores non-text parts when building text",
  ignoresNonTextPartsWhenBuildingText,
);

function setsIsFromMeTrueWhenSenderMatchesOwnAgentId() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });

    fake.emit.message(buildMessage({ senderId: "agent-self" }));
    yield* flushDispatchChainEffect;

    expect(inbound[0]!.isFromMe).toBe(true);
  });
}

effectTest(
  "sets isFromMe=true when sender matches ownAgentId",
  setsIsFromMeTrueWhenSenderMatchesOwnAgentId,
);

function forwardsReplyToIdFromTheMessageFrame() {
  return Effect.gen(function* () {
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");

    fake.emit.message(buildMessage({ replyToId: "msg-parent-123" }));
    yield* flushDispatchChainEffect;

    expect(inbound[0]!.replyToId).toBe(message("msg-parent-123"));
  });
}

effectTest(
  "forwards replyToId from the message frame",
  forwardsReplyToIdFromTheMessageFrame,
);

function logsFailuresFromTheInboundHandlerSEffectErrorChannelAndKeepsTheConsumerAlive() {
  return Effect.gen(function* () {
    const { fake, core } = customSetup();
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");

    let handlerShouldFail = true;
    const received: EnrichedInboundMessage[] = [];
    // Replace the setup's default capture handler with one that can fail.
    core.onInbound((m) =>
      Effect.gen(function* () {
        if (handlerShouldFail) {
          yield* Effect.fail(
            new TestInboundHandlerError({ message: "handler boom" }),
          );
        }
        received.push(m);
      }),
    );

    fake.emit.message(buildMessage({ id: "msg-1" }));
    yield* flushDispatchChainEffect;

    expect(received).toHaveLength(0);

    // Recovery: subsequent message lands cleanly.
    handlerShouldFail = false;
    fake.emit.message(buildMessage({ id: "msg-2" }));
    yield* flushDispatchChainEffect;
    expect(received).toHaveLength(1);
    expect(received[0]!.id).toBe(message("msg-2"));
  });
}

effectTest(
  "logs failures from the inbound handler's Effect error channel and keeps the consumer alive",
  logsFailuresFromTheInboundHandlerSEffectErrorChannelAndKeepsTheConsumerAlive,
);

function logsSynchronousDefectsThrownFromInsideTheHandlerSEffect() {
  return Effect.gen(function* () {
    const { fake, core } = customSetup();
    fake.state.setConversation("conv-1", { type: "dm", participants: [] });
    fake.state.setAgentName("agent-alice", "Alice");

    core.onInbound((_m) =>
      Effect.sync(() => {
        throw new Error("sync defect");
      }),
    );

    fake.emit.message(buildMessage({ id: "msg-1" }));
    yield* flushDispatchChainEffect;

    // Consumer fiber survives a defect and continues to dispatch later messages.
    const next: EnrichedInboundMessage[] = [];
    core.onInbound((m) =>
      Effect.sync(() => {
        next.push(m);
      }),
    );
    fake.emit.message(buildMessage({ id: "msg-2" }));
    yield* flushDispatchChainEffect;
    expect(next.map((r) => r.id)).toEqual([message("msg-2")]);
  });
}

effectTest(
  "logs synchronous defects thrown from inside the handler's Effect",
  logsSynchronousDefectsThrownFromInsideTheHandlerSEffect,
);
