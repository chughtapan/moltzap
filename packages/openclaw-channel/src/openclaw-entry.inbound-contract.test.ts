import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { live as it } from "@effect/vitest";
import * as fc from "fast-check";
import { Data, Effect } from "effect";
import type { CrossConvMessage } from "@moltzap/client/channel-base";
import {
  createFakeChannelService,
  type FakeChannelService,
  flushDispatchChainEffect,
  testAgentId,
  testConversationId,
  testMessageId,
  testTaskId,
} from "@moltzap/client/test-utils";
import type { Message } from "@moltzap/protocol/message";
import { createMoltzapChannelPlugin } from "./openclaw-entry.js";

// Header literal from channel-base's `json-header` markup variant (per spec
// C #597 invariant: byte-identical to the pre-refactor openclaw output).
const CROSS_CONV_HEADER = "Messages (untrusted metadata):";

const MESSAGE_DISPATCH_SETTLE_MS = 100;
const TEST_ACCOUNT_ID = "test-account";
const PROFILE_ACCOUNT_ID = "profile-account";
const DEFAULT_AGENT_NAME = "bob";
const CHANNEL_ID = "moltzap";
const DEFAULT_MESSAGE_ID = testMessageId(
  "550e8400-e29b-41d4-a716-446655440100",
);
const SECOND_MESSAGE_ID = testMessageId("550e8400-e29b-41d4-a716-446655440101");
const DEFAULT_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440200",
);
const ORIGINATING_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440201",
);
const ORIGINATING_TASK_ID = testTaskId("inbound-originating");
const GROUP_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440202",
);
const OTHER_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440203",
);
const SENDER_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440300");
const SELF_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440301");
const THIRD_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440302");
const SELLER_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440303");
const CREATED_AT = "2026-03-16T00:00:00Z";
const DEFAULT_BODY = "Hello from agent";
const TEST_BODY = "Test body content";
const PROJECT_ALPHA = "Project Alpha";
const ATLAS_PRIME = "Atlas-Prime";
const CACHED_NAME = "cached-name";
const MULTILINE_BODY = "Line 1\nLine 2\nLine 3";
const OFFER_QUESTION = "What should I offer?";
const PLAIN_MESSAGE = "Plain message";
const MIN_PRICE_TEXT = "Min $4000";
const SELLER_NAME = "seller";
const CROSS_CONV_SENDER_JSON = '"sender": "seller"';
const CROSS_CONV_TEXT_JSON = '"text": "Min $4000"';
const SYSTEM_REMINDER_TAG = "<system-reminder>";
const FUNCTION_TYPE = "function";
const NUMBER_TYPE = "number";
const DIRECT_CHAT_TYPE = "direct";
const GROUP_CHAT_TYPE = "group";
const TEXT_PART_TYPE = "text";

class InboundContractTestError extends Data.TaggedError(
  "InboundContractTestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface DispatchCall {
  readonly ctx: Record<string, unknown>;
  readonly cfg: unknown;
  readonly dispatcherOptions: {
    readonly deliver: (
      payload: unknown,
      info?: unknown,
    ) => PromiseLike<boolean>;
  };
}

interface StartedGateway {
  readonly fixture: FakeChannelService;
  readonly plugin: ReturnType<typeof createMoltzapChannelPlugin>;
}

let started: StartedGateway;
let abortControllers: AbortController[] = [];
let mockDispatch: ReturnType<typeof vi.fn>;
let setStatusCalls: Record<string, unknown>[];

beforeEach(() => {
  resetMocks();
  started = startGateway({ withRuntime: true });
});

afterEach(() => {
  for (const controller of abortControllers) {
    controller.abort();
  }
  abortControllers = [];
});

describe("Flow 5: Inbound contract", () => {
  it("calls dispatchReplyWithBufferedBlockDispatcher", dispatchIsCalled);
  it("MsgContext has required fields", contextHasRequiredFields);
  it("OriginatingChannel is moltzap", originatingChannelIsMoltzap);
  it("OriginatingTo is the conversationId", originatingToIsConversationId);
  it("group message includes group metadata", groupMessageIncludesMetadata);
  it("DM message has direct ChatType", dmMessageHasDirectChatType);
  it("SenderName is resolved from service", senderNameIsResolved);
  it("caches sender name lookups across messages", cachesSenderNames);
  it("passes cfg through to dispatch", cfgPassesThrough);
  it("dispatch includes a deliver callback", dispatchIncludesDeliver);
  it("updates status with lastInboundAt", updatesInboundStatus);
  it("does not dispatch without channelRuntime", noRuntimeDoesNotDispatch);
  it("handles multi-part text messages", joinsMultipartText);
  it("BodyForAgent includes cross-conversation context", includesCrossConv);
  it("BodyForAgent equals Body for empty context", emptyContextKeepsBody);
  it("uses account id as the MoltZap profile name", accountIdIsProfileName);
  it(
    "property: generated account ids round-trip in config",
    accountIdsRoundTrip,
  );
});

function resetMocks(): void {
  vi.clearAllMocks();
  mockDispatch = vi.fn().mockResolvedValue({ queuedFinal: true });
  setStatusCalls = [];
}

function startGateway(params: {
  readonly withRuntime: boolean;
}): StartedGateway {
  const fixture = createFakeChannelService({ ownAgentId: SELF_AGENT_ID });
  seedFixture(fixture);
  const plugin = createMoltzapChannelPlugin({
    createService: () => fixture.service,
  });
  const abortController = new AbortController();
  abortControllers.push(abortController);
  Effect.runFork(
    Effect.tryPromise({
      try: () =>
        plugin.gateway.startAccount({
          cfg: makeCfg(),
          accountId: TEST_ACCOUNT_ID,
          account: makeAccount(TEST_ACCOUNT_ID),
          abortSignal: abortController.signal,
          setStatus: (status) => setStatusCalls.push(status),
          ...(params.withRuntime ? { channelRuntime: channelRuntime() } : {}),
        }),
      catch: (cause) =>
        new InboundContractTestError({
          message: "startAccount failed",
          cause,
        }),
    }).pipe(Effect.ignore),
  );
  return { fixture, plugin };
}

function seedFixture(fixture: FakeChannelService): void {
  fixture.state.setConversation(DEFAULT_CONVERSATION_ID, defaultConversation());
  fixture.state.setAgentName(SENDER_AGENT_ID, `name-of-${SENDER_AGENT_ID}`);
}

function channelRuntime() {
  return {
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: mockDispatch,
    },
  };
}

function makeAccount(id: string) {
  return {
    id,
    agentName: DEFAULT_AGENT_NAME,
  };
}

function makeCfg(accountId = TEST_ACCOUNT_ID) {
  return {
    channels: {
      moltzap: {
        accounts: [makeAccount(accountId)],
      },
    },
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: DEFAULT_MESSAGE_ID,
    conversationId: DEFAULT_CONVERSATION_ID,
    senderId: SENDER_AGENT_ID,
    parts: [{ type: TEXT_PART_TYPE, text: DEFAULT_BODY }],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function defaultConversation() {
  return {
    id: DEFAULT_CONVERSATION_ID,
    type: "dm",
    participants: [agentRef(SENDER_AGENT_ID), agentRef(SELF_AGENT_ID)],
  };
}

function agentRef(id: string): string {
  return `agent:${id}`;
}

function waitForDispatchTimes(count: number) {
  return waitForExpectation(() => {
    expect(mockDispatch).toHaveBeenCalledTimes(count);
  }, "dispatch call");
}

function waitForExpectation(assertion: () => void, label: string) {
  return Effect.tryPromise({
    try: () => vi.waitFor(assertion),
    catch: (cause) =>
      new InboundContractTestError({ message: `wait for ${label}`, cause }),
  });
}

function emitMessage(
  message: Message = makeMessage(),
  taskId?: import("@moltzap/protocol/task").TaskId,
) {
  return Effect.gen(function* () {
    started.fixture.emit.message(message, taskId);
    yield* flushDispatchChainEffect;
  });
}

function firstDispatchCall(): DispatchCall {
  return mockDispatch.mock.calls[0]?.[0] as DispatchCall;
}

function firstDispatchContext(): Record<string, unknown> {
  return firstDispatchCall().ctx;
}

function dispatchIsCalled() {
  return Effect.gen(function* () {
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.any(Object),
        cfg: expect.any(Object),
        dispatcherOptions: expect.objectContaining({
          deliver: expect.any(Function),
        }),
      }),
    );
  });
}

function contextHasRequiredFields() {
  return Effect.gen(function* () {
    yield* emitMessage(
      makeMessage({ parts: [{ type: TEXT_PART_TYPE, text: TEST_BODY }] }),
    );
    yield* waitForDispatchTimes(1);
    const ctx = firstDispatchContext();
    expect(ctx.Body).toBe(TEST_BODY);
    expect(ctx.BodyForAgent).toBe(TEST_BODY);
    expect(ctx.From).toBe(agentRef(SENDER_AGENT_ID));
    expect(ctx.To).toBe(DEFAULT_AGENT_NAME);
    expect(ctx.SessionKey).toBe(
      sessionKey(DIRECT_CHAT_TYPE, DEFAULT_CONVERSATION_ID),
    );
    expect(ctx.Provider).toBe(CHANNEL_ID);
    expect(ctx.Surface).toBe(CHANNEL_ID);
    expect(ctx.AccountId).toBe(TEST_ACCOUNT_ID);
  });
}

function originatingChannelIsMoltzap() {
  return Effect.gen(function* () {
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    expect(firstDispatchContext().OriginatingChannel).toBe(CHANNEL_ID);
  });
}

function originatingToIsConversationId() {
  return Effect.gen(function* () {
    yield* emitMessage(
      makeMessage({ conversationId: ORIGINATING_CONVERSATION_ID }),
      ORIGINATING_TASK_ID,
    );
    yield* waitForDispatchTimes(1);
    expect(firstDispatchContext().OriginatingTo).toBe(
      `task:${ORIGINATING_TASK_ID}:${ORIGINATING_CONVERSATION_ID}`,
    );
  });
}

function groupMessageIncludesMetadata() {
  return Effect.gen(function* () {
    started.fixture.state.setConversation(
      GROUP_CONVERSATION_ID,
      groupConversation(),
    );
    yield* emitMessage(makeMessage({ conversationId: GROUP_CONVERSATION_ID }));
    yield* waitForDispatchTimes(1);
    const ctx = firstDispatchContext();
    expect(ctx.ChatType).toBe(GROUP_CHAT_TYPE);
    expect(ctx.GroupSubject).toBe(PROJECT_ALPHA);
    expect(ctx.GroupMembers).toBe(groupMembers());
    expect(ctx.ConversationLabel).toBe(PROJECT_ALPHA);
    expect(ctx.SessionKey).toBe(
      sessionKey(GROUP_CHAT_TYPE, GROUP_CONVERSATION_ID),
    );
  });
}

function groupConversation() {
  return {
    id: GROUP_CONVERSATION_ID,
    type: "group",
    name: PROJECT_ALPHA,
    participants: [
      agentRef(SENDER_AGENT_ID),
      agentRef(SELF_AGENT_ID),
      agentRef(THIRD_AGENT_ID),
    ],
  };
}

function groupMembers(): string {
  return [
    agentRef(SENDER_AGENT_ID),
    agentRef(SELF_AGENT_ID),
    agentRef(THIRD_AGENT_ID),
  ].join(",");
}

function dmMessageHasDirectChatType() {
  return Effect.gen(function* () {
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    expect(firstDispatchContext().ChatType).toBe(DIRECT_CHAT_TYPE);
  });
}

function senderNameIsResolved() {
  return Effect.gen(function* () {
    started.fixture.state.setAgentName(SENDER_AGENT_ID, ATLAS_PRIME);
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    expect(firstDispatchContext().SenderName).toBe(ATLAS_PRIME);
  });
}

function cachesSenderNames() {
  return Effect.gen(function* () {
    started.fixture.state.setAgentName(SENDER_AGENT_ID, CACHED_NAME);
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    yield* emitMessage(makeMessage({ id: SECOND_MESSAGE_ID }));
    yield* waitForDispatchTimes(2);
    expect(
      started.fixture.state.resolveAgentNameCallCount(SENDER_AGENT_ID),
    ).toBe(0);
  });
}

function cfgPassesThrough() {
  return Effect.gen(function* () {
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    expect(firstDispatchCall().cfg).toEqual(makeCfg());
  });
}

function dispatchIncludesDeliver() {
  return Effect.gen(function* () {
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    expect(typeof firstDispatchCall().dispatcherOptions.deliver).toBe(
      FUNCTION_TYPE,
    );
  });
}

function updatesInboundStatus() {
  return Effect.gen(function* () {
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    const inboundStatus = setStatusCalls.find(
      (status) => "lastInboundAt" in status,
    );
    expect(inboundStatus).toBeDefined();
    if (inboundStatus === undefined) return;
    expect(inboundStatus.accountId).toBe(TEST_ACCOUNT_ID);
    expect(typeof inboundStatus.lastInboundAt).toBe(NUMBER_TYPE);
  });
}

function noRuntimeDoesNotDispatch() {
  return Effect.gen(function* () {
    const before = mockDispatch.mock.calls.length;
    const withoutRuntime = startGateway({ withRuntime: false });
    withoutRuntime.fixture.emit.message(makeMessage());
    yield* Effect.sleep(`${MESSAGE_DISPATCH_SETTLE_MS} millis`);
    expect(mockDispatch.mock.calls.length).toBe(before);
  });
}

function joinsMultipartText() {
  return Effect.gen(function* () {
    yield* emitMessage(
      makeMessage({
        parts: [
          { type: TEXT_PART_TYPE, text: "Line 1" },
          { type: TEXT_PART_TYPE, text: "Line 2" },
          { type: TEXT_PART_TYPE, text: "Line 3" },
        ],
      }),
    );
    yield* waitForDispatchTimes(1);
    const ctx = firstDispatchContext();
    expect(ctx.Body).toBe(MULTILINE_BODY);
    expect(ctx.BodyForAgent).toBe(MULTILINE_BODY);
  });
}

function includesCrossConv() {
  return Effect.gen(function* () {
    started.fixture.state.setFullMessages(DEFAULT_CONVERSATION_ID, [
      crossConversationMessage(),
    ]);
    yield* emitMessage(
      makeMessage({ parts: [{ type: TEXT_PART_TYPE, text: OFFER_QUESTION }] }),
    );
    yield* waitForDispatchTimes(1);
    const ctx = firstDispatchContext();
    expect(ctx.Body).toBe(OFFER_QUESTION);
    expect(ctx.BodyForAgent).toContain(CROSS_CONV_HEADER);
    expect(ctx.BodyForAgent).toContain(CROSS_CONV_SENDER_JSON);
    expect(ctx.BodyForAgent).toContain(CROSS_CONV_TEXT_JSON);
    expect(ctx.BodyForAgent).toContain(OFFER_QUESTION);
    expect(ctx.BodyForAgent).not.toContain(SYSTEM_REMINDER_TAG);
  });
}

function crossConversationMessage(): CrossConvMessage {
  return {
    conversationId: OTHER_CONVERSATION_ID,
    conversationName: undefined,
    senderName: SELLER_NAME,
    senderId: SELLER_AGENT_ID,
    text: MIN_PRICE_TEXT,
    timestamp: CREATED_AT,
  };
}

function emptyContextKeepsBody() {
  return Effect.gen(function* () {
    yield* emitMessage(
      makeMessage({ parts: [{ type: TEXT_PART_TYPE, text: PLAIN_MESSAGE }] }),
    );
    yield* waitForDispatchTimes(1);
    const ctx = firstDispatchContext();
    expect(ctx.Body).toBe(PLAIN_MESSAGE);
    expect(ctx.BodyForAgent).toBe(PLAIN_MESSAGE);
  });
}

function accountIdIsProfileName() {
  return Effect.gen(function* () {
    const fixture = createFakeChannelService({ ownAgentId: SELF_AGENT_ID });
    const calls: Array<{
      readonly profileName: string;
      readonly accountId: string;
    }> = [];
    const plugin = createMoltzapChannelPlugin({
      createService: (profileName, account) => {
        calls.push({ profileName, accountId: account.id });
        return fixture.service;
      },
    });
    const abortController = new AbortController();
    abortController.abort();
    yield* Effect.tryPromise({
      try: () =>
        plugin.gateway.startAccount({
          cfg: makeCfg(PROFILE_ACCOUNT_ID),
          accountId: PROFILE_ACCOUNT_ID,
          account: makeAccount(PROFILE_ACCOUNT_ID),
          abortSignal: abortController.signal,
          setStatus: vi.fn(),
        }),
      catch: (cause) =>
        new InboundContractTestError({
          message: "start profile account",
          cause,
        }),
    });
    expect(calls).toEqual([
      { profileName: PROFILE_ACCOUNT_ID, accountId: PROFILE_ACCOUNT_ID },
    ]);
  });
}

function accountIdsRoundTrip() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (accountId) => {
        expect(makeCfg(accountId).channels.moltzap.accounts[0]?.id).toBe(
          accountId,
        );
      }),
    );
  });
}

function sessionKey(type: string, id: string): string {
  return `agent:main:${CHANNEL_ID}:${type === GROUP_CHAT_TYPE ? "group" : "dm"}:${id}`;
}
