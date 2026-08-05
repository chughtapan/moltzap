import { live as it } from "@effect/vitest";
import type { CrossConvMessage } from "@moltzap/client/channel-base";
import { testAgentId, testConversationId } from "@moltzap/client/test-utils";
import { Effect, Fiber } from "effect";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { createMoltzapChannelPlugin } from "./openclaw-entry.js";
import {
  ACCOUNT_AGENT_NAME,
  ACCOUNT_ID,
  CONVERSATION_ID,
  CREATED_AT,
  SELF_AGENT_ID,
  SENDER_AGENT_ID,
  SENDER_AGENT_NAME,
  cleanUpStart,
  createHarnessFixture,
  firstDispatchCall,
  makeAccount,
  makeConfig,
  offerHarnessTurn,
  runHarnessPromise,
  startHarnessGateway,
  waitForDispatchTimes,
  waitForHarnessExpectation,
  type HarnessFixture,
} from "./test-utils/harness-fixture.js";

// Header literal from channel-base's `json-header` markup variant (per spec
// C #597 invariant: byte-identical to the pre-refactor openclaw output).
const CROSS_CONV_HEADER = "Messages (untrusted metadata):";

const PROFILE_ACCOUNT_ID = "profile-account";
const CHANNEL_ID = "moltzap";
const ORIGINATING_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440201",
);
const GROUP_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440202",
);
const OTHER_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440203",
);
const THIRD_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440302");
const SELLER_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440303");
const TEST_BODY = "Test body content";
const PROJECT_ALPHA = "Project Alpha";
const OFFER_QUESTION = "What should I offer?";
const PLAIN_MESSAGE = "Plain message";
const MIN_PRICE_TEXT = "Min $4000";
const SELLER_NAME = "seller";
const CROSS_CONV_SENDER_JSON = '"sender": "seller"';
const CROSS_CONV_TEXT_JSON = '"text": "Min $4000"';
const SYSTEM_REMINDER_TAG = "<system-reminder>";
const FUNCTION_TYPE = "function";
const OBJECT_TYPE = "object";
const NUMBER_TYPE = "number";
const DIRECT_CHAT_TYPE = "direct";
const GROUP_CHAT_TYPE = "group";

let fixture: HarnessFixture;
let started: ReturnType<typeof startHarnessGateway>;
let extraStarts: Array<ReturnType<typeof startHarnessGateway>> = [];

beforeEach(() => {
  fixture = createHarnessFixture();
  started = startHarnessGateway(fixture);
});

afterEach(() => {
  const starts = [started, ...extraStarts];
  extraStarts = [];
  return Effect.runPromise(
    Effect.all(
      starts.map((start) => cleanUpStart(start)),
      { discard: true },
    ),
  );
});

describe("Flow 5: Inbound contract", () => {
  it("calls dispatchReplyWithBufferedBlockDispatcher", dispatchIsCalled);
  it("MsgContext has required fields", contextHasRequiredFields);
  it("OriginatingChannel is moltzap", originatingChannelIsMoltzap);
  it("OriginatingTo is the conversationId", originatingToIsConversationId);
  it("group turn includes group metadata", groupTurnIncludesMetadata);
  it("DM turn has direct ChatType", dmTurnHasDirectChatType);
  it("SenderName comes from the turn", senderNameComesFromTurn);
  it("passes cfg through to dispatch", cfgPassesThrough);
  it("dispatch includes a deliver callback", dispatchIncludesDeliver);
  it("updates status with lastInboundAt", updatesInboundStatus);
  it("does not dispatch without channelRuntime", noRuntimeDoesNotDispatch);
  it("BodyForAgent includes cross-conversation context", includesCrossConv);
  it("BodyForAgent equals Body for empty context", emptyContextKeepsBody);
  it("uses account id as the MoltZap profile name", accountIdIsProfileName);
  it(
    "property: generated account ids round-trip in config",
    accountIdsRoundTrip,
  );
});

function agentRef(id: string): string {
  return `agent:${id}`;
}

function sessionKey(type: string, id: string): string {
  return `agent:main:${CHANNEL_ID}:${type === GROUP_CHAT_TYPE ? "group" : "dm"}:${id}`;
}

function firstDispatchContext(): Record<string, unknown> {
  return firstDispatchCall(started.dispatch).ctx;
}

function dispatchIsCalled() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    const dispatch = firstDispatchCall(started.dispatch);
    expect(typeof dispatch.ctx).toBe(OBJECT_TYPE);
    expect(typeof dispatch.cfg).toBe(OBJECT_TYPE);
    expect(typeof dispatch.dispatcherOptions.deliver).toBe(FUNCTION_TYPE);
  });
}

function contextHasRequiredFields() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture, { text: TEST_BODY });
    yield* waitForDispatchTimes(started.dispatch, 1);
    const ctx = firstDispatchContext();
    expect(ctx.Body).toBe(TEST_BODY);
    expect(ctx.BodyForAgent).toBe(TEST_BODY);
    expect(ctx.From).toBe(agentRef(SENDER_AGENT_ID));
    expect(ctx.To).toBe(ACCOUNT_AGENT_NAME);
    expect(ctx.SessionKey).toBe(sessionKey(DIRECT_CHAT_TYPE, CONVERSATION_ID));
    expect(ctx.Provider).toBe(CHANNEL_ID);
    expect(ctx.Surface).toBe(CHANNEL_ID);
    expect(ctx.AccountId).toBe(ACCOUNT_ID);
  });
}

function originatingChannelIsMoltzap() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(firstDispatchContext().OriginatingChannel).toBe(CHANNEL_ID);
  });
}

function originatingToIsConversationId() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture, {
      conversationId: ORIGINATING_CONVERSATION_ID,
    });
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(firstDispatchContext().OriginatingTo).toBe(
      `conv:${ORIGINATING_CONVERSATION_ID}`,
    );
  });
}

function groupTurnIncludesMetadata() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture, {
      conversationId: GROUP_CONVERSATION_ID,
      conversationMeta: {
        type: "group",
        name: PROJECT_ALPHA,
        participants: groupParticipants(),
      },
    });
    yield* waitForDispatchTimes(started.dispatch, 1);
    const ctx = firstDispatchContext();
    expect(ctx.ChatType).toBe(GROUP_CHAT_TYPE);
    expect(ctx.GroupSubject).toBe(PROJECT_ALPHA);
    expect(ctx.GroupMembers).toBe(groupParticipants().join(","));
    expect(ctx.ConversationLabel).toBe(PROJECT_ALPHA);
    expect(ctx.SessionKey).toBe(
      sessionKey(GROUP_CHAT_TYPE, GROUP_CONVERSATION_ID),
    );
  });
}

function groupParticipants(): string[] {
  return [
    agentRef(SENDER_AGENT_ID),
    agentRef(SELF_AGENT_ID),
    agentRef(THIRD_AGENT_ID),
  ];
}

function dmTurnHasDirectChatType() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(firstDispatchContext().ChatType).toBe(DIRECT_CHAT_TYPE);
  });
}

function senderNameComesFromTurn() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(firstDispatchContext().SenderName).toBe(SENDER_AGENT_NAME);
  });
}

function cfgPassesThrough() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(firstDispatchCall(started.dispatch).cfg).toEqual(makeConfig());
  });
}

function dispatchIncludesDeliver() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(
      typeof firstDispatchCall(started.dispatch).dispatcherOptions.deliver,
    ).toBe(FUNCTION_TYPE);
  });
}

function updatesInboundStatus() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    const inboundStatus = started.setStatus.mock.calls
      .map(([status]) => status)
      .find((status) => "lastInboundAt" in status);
    expect(inboundStatus).toBeDefined();
    expect(inboundStatus?.accountId).toBe(ACCOUNT_ID);
    expect(typeof inboundStatus?.lastInboundAt).toBe(NUMBER_TYPE);
  });
}

// The warning proves the turn reached the inbound handler, so the missing
// dispatcher is the reason nothing dispatched.
function noRuntimeDoesNotDispatch() {
  return Effect.gen(function* () {
    const otherFixture = createHarnessFixture();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const withoutRuntime = startHarnessGateway(otherFixture, {
      log,
      withoutChannelRuntime: true,
    });
    extraStarts.push(withoutRuntime);
    yield* offerHarnessTurn(otherFixture);
    yield* waitForHarnessExpectation(() => {
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `no OpenClaw reply dispatcher for ${CONVERSATION_ID}`,
        ),
      );
    }, "wait for missing dispatcher warning");
    expect(withoutRuntime.dispatch).not.toHaveBeenCalled();
  });
}

function includesCrossConv() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture, {
      text: OFFER_QUESTION,
      contextBlocks: {
        crossConversationMessages: [crossConversationMessage()],
      },
    });
    yield* waitForDispatchTimes(started.dispatch, 1);
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
    yield* offerHarnessTurn(fixture, { text: PLAIN_MESSAGE });
    yield* waitForDispatchTimes(started.dispatch, 1);
    const ctx = firstDispatchContext();
    expect(ctx.Body).toBe(PLAIN_MESSAGE);
    expect(ctx.BodyForAgent).toBe(PLAIN_MESSAGE);
  });
}

function accountIdIsProfileName() {
  const profileFixture = createHarnessFixture();
  const calls: Array<{
    readonly profileName: string;
    readonly accountId: string;
  }> = [];
  const plugin = createMoltzapChannelPlugin({
    harnessClientForAccount: (profileName, account) => {
      calls.push({ profileName, accountId: account.id });
      return profileFixture.client;
    },
  });
  const abortController = new AbortController();
  const startFiber = Effect.runFork(
    runHarnessPromise("start profile account", () =>
      plugin.gateway.startAccount({
        cfg: makeConfig(PROFILE_ACCOUNT_ID),
        accountId: PROFILE_ACCOUNT_ID,
        account: makeAccount(PROFILE_ACCOUNT_ID),
        abortSignal: abortController.signal,
        setStatus: vi.fn(),
      }),
    ),
  );
  return waitForHarnessExpectation(() => {
    expect(calls).toEqual([
      { profileName: PROFILE_ACCOUNT_ID, accountId: PROFILE_ACCOUNT_ID },
    ]);
  }, "wait for the profile client injection").pipe(
    Effect.ensuring(
      Effect.sync(() => {
        abortController.abort();
      }).pipe(Effect.zipRight(Fiber.interrupt(startFiber)), Effect.asVoid),
    ),
  );
}

function accountIdsRoundTrip() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (accountId) => {
        expect(makeConfig(accountId).channels.moltzap.accounts[0]?.id).toBe(
          accountId,
        );
      }),
    );
  });
}
