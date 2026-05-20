import { live as it } from "@effect/vitest";
import {
  buildMessage,
  createFakeChannelService,
  flushDispatchChainEffect,
  testAgentId,
  testConversationId,
  testMessageId,
  testTaskId,
  type FakeChannelService,
} from "@moltzap/client/test-utils";
import type { ServiceRpcError } from "@moltzap/client";
import {
  AgentsLookup,
  ConversationsGet,
  MessagesSend,
  type ParamsOf,
  type ResultOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import { TaskClosedError } from "@moltzap/protocol/task";
import { RpcServerError } from "@moltzap/protocol/transport";
import { Data, Effect } from "effect";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { createMoltzapChannelPlugin } from "./openclaw-entry.js";

const ACCOUNT_ID = "delivery-test";
const ACCOUNT_KEY = "moltzap_agent_delivery";
const SERVER_URL = "ws://localhost:9999";
const ACCOUNT_AGENT_NAME = "bob-delivery";
const SELF_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440401");
const SENDER_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440402");
const DEFAULT_MESSAGE_ID = testMessageId(
  "550e8400-e29b-41d4-a716-446655440403",
);
const DEFAULT_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440404",
);
const TARGET_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440405",
);
const DEFAULT_TASK_ID = testTaskId("delivery-default");
const TARGET_TASK_ID = testTaskId("delivery-target");
const OUTBOUND_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440406",
);
const REPLY_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440407",
);
const NO_REPLY_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440408",
);
const STOP_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440409",
);
const OUTBOUND_TASK_ID = testTaskId("delivery-outbound");
const REPLY_TASK_ID = testTaskId("delivery-reply");
const NO_REPLY_TASK_ID = testTaskId("delivery-no-reply");
const STOP_TASK_ID = testTaskId("delivery-stop");
const OUTBOUND_TARGET = `task:${OUTBOUND_TASK_ID}:${OUTBOUND_CONVERSATION_ID}`;
const REPLY_TARGET = `task:${REPLY_TASK_ID}:${REPLY_CONVERSATION_ID}`;
const NO_REPLY_TARGET = `task:${NO_REPLY_TASK_ID}:${NO_REPLY_CONVERSATION_ID}`;
const STOP_TARGET = `task:${STOP_TASK_ID}:${STOP_CONVERSATION_ID}`;
const AGENT_NOVA_TARGET = "agent:nova";
const AGENT_NOVA_NAME = "nova";
const TRIGGER_TEXT = "Trigger message";
const REPLY_TEXT = "reply text";
const FIRST_REPLY_TEXT = "first reply";
const SECOND_REPLY_TEXT = "second reply";
const PARTIAL_TEXT = "partial";
const OUTBOUND_TEXT = "Hello from outbound";
const AGENT_TEXT = "Hello nova";
const AGENT_REPLY_TEXT = "Reply text";
const NO_REPLY_TEXT = "No reply ref";
const BEFORE_STOP_TEXT = "before stop";
const AFTER_STOP_TEXT = "after stop";
const PARENT_MESSAGE_ID = testMessageId("550e8400-e29b-41d4-a716-446655440410");
const LOOKUP_FAILED_MESSAGE = "lookup failed";
const SERVER_REJECTED_MESSAGE = "Server rejected";
const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error";
const NON_TASK_CLOSED_CODE = -32001;
const TEXT_PART_TYPE = "text";
const FINAL_KIND = "final";
const TOOL_KIND = "tool";

type SendTextInput = Parameters<
  ReturnType<typeof createMoltzapChannelPlugin>["outbound"]["sendText"]
>[0];
type SendTextResult = Awaited<
  ReturnType<
    ReturnType<typeof createMoltzapChannelPlugin>["outbound"]["sendText"]
  >
>;
type DeliverInput = {
  readonly text?: string;
  readonly body?: string;
};
type DeliverInfo = {
  readonly kind?: string;
};
type Deliver = (
  payload: DeliverInput,
  info?: DeliverInfo,
) => PromiseLike<boolean>;
type DispatchCall = {
  readonly dispatcherOptions: {
    readonly deliver: Deliver;
  };
};
type DispatchCallWithContext = DispatchCall & {
  readonly ctx: {
    readonly OriginatingTo?: unknown;
  };
};
type SendFn = (
  taskId: string,
  conversationId: string,
  text: string,
  opts?: { readonly replyTo?: string; readonly dispatchLeaseId?: string },
) => Effect.Effect<void, ServiceRpcError>;
type SendToAgentFn = (
  agentName: string,
  text: string,
  opts?: { readonly replyTo?: string },
) => Effect.Effect<void, unknown>;
type SendRpcFn = <D extends RpcDefinition<string, any, any>>(
  definition: D,
  params: ParamsOf<D>,
) => Effect.Effect<ResultOf<D>, ServiceRpcError>;
type TestService = FakeChannelService["service"] & {
  readonly send: SendFn;
  readonly sendRpc: SendRpcFn;
  readonly sendToAgent: SendToAgentFn;
};

class DeliveryTestError extends Data.TaggedError("DeliveryTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class SendToAgentTestFailure extends Data.TaggedError(
  "SendToAgentTestFailure",
)<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const mockSend = vi.fn<SendFn>();
const mockSendToAgent = vi.fn<SendToAgentFn>();
const mockSendRpc = vi.fn<SendRpcFn>();

let started: {
  readonly fixture: FakeChannelService;
  readonly plugin: ReturnType<typeof createMoltzapChannelPlugin>;
};
let abortControllers: AbortController[] = [];
let mockDispatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  started = startGateway();
});

afterEach(() => {
  for (const controller of abortControllers) {
    controller.abort();
  }
  abortControllers = [];
});

describe("Flow 6: Outbound delivery - deliver callback + sendText", () => {
  it("deliver callback returns true", deliverReturnsTrue);
  it(
    "deliver callback rejects duplicate final delivery",
    rejectsDuplicateFinal,
  );
  it("deliver callback returns true for non-final replies", nonFinalIsIgnored);
  it("sendText uses OriginatingTo as conversation id", usesOriginatingTo);
  it("sendText sends to the right conversation", sendsToConversation);
  it("sendText includes replyToId when present", includesReplyTo);
  it("sendText omits replyToId when not provided", omitsReplyTo);
  it("resolveTarget accepts agent targets", acceptsAgentTarget);
  it("resolveTarget accepts conversation IDs", acceptsConversationTarget);
  it("resolveTarget rejects empty strings", rejectsEmptyTarget);
  it("sendText delegates agent targets", delegatesAgentTarget);
  it("sendText forwards agent replyToId", forwardsAgentReplyTo);
  it("sendText reports sendToAgent failures", reportsSendToAgentFailure);
  it("sendText reports disconnected clients", reportsDisconnectedClient);
  it("sendText reports send failures", reportsSendFailure);
  it("deliver treats TaskClosed as terminal consumed", taskClosedIsConsumed);
  it("deliver reports non-TaskClosed RPC failures", nonTaskClosedFails);
  it(
    "lease guard stays unconsumed on transient send failure",
    leaseGuardUnconsumedOnTransientFailure,
  );
  it("stopAccount removes client from active pool", stopRemovesClient);
  it("property: resolveTarget accepts generated plain ids", plainIdsResolve);
});

function startGateway() {
  vi.clearAllMocks();
  mockDispatch = vi.fn().mockResolvedValue({ queuedFinal: true });
  const fixture = createFakeChannelService({ ownAgentId: SELF_AGENT_ID });
  fixture.state.setConversation(DEFAULT_CONVERSATION_ID, defaultConversation());
  fixture.state.setAgentName(SENDER_AGENT_ID, "Atlas");
  const service = createTestService(fixture);
  const plugin = createMoltzapChannelPlugin({ createService: () => service });
  const abortController = new AbortController();
  abortControllers.push(abortController);
  plugin.gateway.startAccount({
    cfg: makeCfg(),
    accountId: ACCOUNT_ID,
    account: makeAccount(),
    abortSignal: abortController.signal,
    log: testLogger(),
    setStatus: vi.fn(),
    channelRuntime: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: mockDispatch,
      },
    },
  });
  return { fixture, plugin };
}

function createTestService(fixture: FakeChannelService): TestService {
  mockSend.mockImplementation(fixture.service.send);
  mockSendToAgent.mockReturnValue(Effect.void);
  mockSendRpc.mockImplementation(sendRpcDefault);
  return {
    ...fixture.service,
    send: mockSend,
    sendRpc: mockSendRpc,
    sendToAgent: mockSendToAgent,
  };
}

function sendRpcDefault<D extends RpcDefinition<string, any, any>>(
  definition: D,
): Effect.Effect<ResultOf<D>, ServiceRpcError> {
  if (definition === AgentsLookup) {
    return Effect.succeed({
      agents: [{ id: SENDER_AGENT_ID, name: "Atlas" }],
    } as ResultOf<D>);
  }
  if (definition === ConversationsGet) {
    return Effect.succeed({
      conversation: { type: "dm" },
      participants: [
        { participant: { type: "agent", id: SENDER_AGENT_ID } },
        { participant: { type: "agent", id: SELF_AGENT_ID } },
      ],
    } as ResultOf<D>);
  }
  if (definition === MessagesSend) {
    return Effect.succeed({ message: { id: "sent-1" } } as ResultOf<D>);
  }
  return Effect.succeed({} as ResultOf<D>);
}

function makeAccount() {
  return {
    id: ACCOUNT_ID,
    apiKey: ACCOUNT_KEY,
    serverUrl: SERVER_URL,
    agentName: ACCOUNT_AGENT_NAME,
  };
}

function makeCfg() {
  return {
    channels: {
      moltzap: {
        accounts: [makeAccount()],
      },
    },
  };
}

function testLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function defaultConversation() {
  return {
    id: DEFAULT_CONVERSATION_ID,
    type: "dm",
    participants: [agentRef(SENDER_AGENT_ID), agentRef(SELF_AGENT_ID)],
  };
}

function agentRef(agentId: string): string {
  return `agent:${agentId}`;
}

function makeDeliveryMessage(
  overrides: Parameters<typeof buildMessage>[0] = {},
) {
  return buildMessage({
    id: DEFAULT_MESSAGE_ID,
    conversationId: DEFAULT_CONVERSATION_ID,
    senderId: SENDER_AGENT_ID,
    parts: [{ type: TEXT_PART_TYPE, text: TRIGGER_TEXT }],
    createdAt: "2026-03-16T00:00:00Z",
    ...overrides,
  });
}

function emitMessage(
  overrides: Parameters<typeof buildMessage>[0] = {},
  taskId = DEFAULT_TASK_ID,
) {
  return Effect.gen(function* () {
    started.fixture.emit.message(makeDeliveryMessage(overrides), taskId);
    yield* flushDispatchChainEffect;
  });
}

function waitForExpectation(assertion: () => void, label: string) {
  return Effect.tryPromise({
    try: () => vi.waitFor(assertion),
    catch: (cause) =>
      new DeliveryTestError({ message: `wait for ${label}`, cause }),
  });
}

function waitForDispatchTimes(count: number) {
  return waitForExpectation(() => {
    expect(mockDispatch).toHaveBeenCalledTimes(count);
  }, "dispatch call");
}

function firstDispatchCall(): DispatchCall {
  return mockDispatch.mock.calls[0]?.[0] as DispatchCall;
}

function firstDispatchCallWithContext(): DispatchCallWithContext {
  return mockDispatch.mock.calls[0]?.[0] as DispatchCallWithContext;
}

function deliverFinal(text: string) {
  return deliver(firstDispatchCall().dispatcherOptions.deliver, {
    text,
    kind: FINAL_KIND,
  });
}

function deliver(
  delivery: Deliver,
  input: DeliverInput & { readonly kind: string },
) {
  return Effect.tryPromise({
    try: () =>
      delivery({ text: input.text, body: input.body }, { kind: input.kind }),
    catch: (cause) =>
      new DeliveryTestError({ message: "deliver failed", cause }),
  });
}

function sendText(input: SendTextInput) {
  return Effect.tryPromise({
    try: () => started.plugin.outbound.sendText(input),
    catch: (cause) =>
      new DeliveryTestError({ message: "sendText failed", cause }),
  });
}

function stopAccount() {
  return Effect.tryPromise({
    try: () =>
      started.plugin.gateway.stopAccount({
        accountId: ACCOUNT_ID,
        log: { info: vi.fn() },
      }),
    catch: (cause) =>
      new DeliveryTestError({ message: "stopAccount failed", cause }),
  });
}

function expectSuccessfulSend(result: SendTextResult): void {
  expect(result.ok).toBe(true);
}

function expectFailureMessage(
  result: SendTextResult,
  expectedMessage: string | RegExp,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  if (typeof expectedMessage === "string") {
    expect(result.error.message).toBe(expectedMessage);
    return;
  }
  expect(result.error.message).toMatch(expectedMessage);
}

function deliverReturnsTrue() {
  return Effect.gen(function* () {
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    const result = yield* deliverFinal(REPLY_TEXT);
    expect(result).toBe(true);
  });
}

function rejectsDuplicateFinal() {
  return Effect.gen(function* () {
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    const sendBefore = mockSend.mock.calls.length;
    const first = yield* deliverFinal(FIRST_REPLY_TEXT);
    const sendAfterFirst = mockSend.mock.calls.length;
    const second = yield* deliverFinal(SECOND_REPLY_TEXT);
    expect(first).toBe(true);
    expect(sendAfterFirst).toBe(sendBefore + 1);
    expect(second).toBe(false);
    expect(mockSend.mock.calls.length).toBe(sendAfterFirst);
  });
}

function nonFinalIsIgnored() {
  return Effect.gen(function* () {
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    const result = yield* deliver(
      firstDispatchCall().dispatcherOptions.deliver,
      {
        text: PARTIAL_TEXT,
        kind: TOOL_KIND,
      },
    );
    expect(result).toBe(true);
  });
}

function usesOriginatingTo() {
  return Effect.gen(function* () {
    yield* emitMessage(
      { conversationId: TARGET_CONVERSATION_ID },
      TARGET_TASK_ID,
    );
    yield* waitForDispatchTimes(1);
    const ctx = firstDispatchCallWithContext().ctx;
    expect(ctx.OriginatingTo).toBe(
      `task:${TARGET_TASK_ID}:${TARGET_CONVERSATION_ID}`,
    );
  });
}

function sendsToConversation() {
  return Effect.gen(function* () {
    const result = yield* sendText({
      cfg: makeCfg(),
      to: OUTBOUND_TARGET,
      text: OUTBOUND_TEXT,
      accountId: ACCOUNT_ID,
    });
    expectSuccessfulSend(result);
    expect(mockSend).toHaveBeenCalledWith(
      OUTBOUND_TASK_ID,
      OUTBOUND_CONVERSATION_ID,
      OUTBOUND_TEXT,
      {},
    );
  });
}

function includesReplyTo() {
  return Effect.gen(function* () {
    const result = yield* sendText({
      cfg: makeCfg(),
      to: REPLY_TARGET,
      text: AGENT_REPLY_TEXT,
      accountId: ACCOUNT_ID,
      replyToId: PARENT_MESSAGE_ID,
    });
    expectSuccessfulSend(result);
    expect(mockSend).toHaveBeenCalledWith(
      REPLY_TASK_ID,
      REPLY_CONVERSATION_ID,
      AGENT_REPLY_TEXT,
      {
        replyTo: PARENT_MESSAGE_ID,
      },
    );
  });
}

function omitsReplyTo() {
  return Effect.gen(function* () {
    yield* sendText({
      cfg: makeCfg(),
      to: NO_REPLY_TARGET,
      text: NO_REPLY_TEXT,
      accountId: ACCOUNT_ID,
    });
    expect(mockSend).toHaveBeenCalledWith(
      NO_REPLY_TASK_ID,
      NO_REPLY_CONVERSATION_ID,
      NO_REPLY_TEXT,
      {},
    );
  });
}

function acceptsAgentTarget() {
  return Effect.sync(() => {
    expect(
      started.plugin.outbound.resolveTarget({
        to: AGENT_NOVA_TARGET,
        cfg: makeCfg(),
      }),
    ).toMatchObject({ ok: true, to: AGENT_NOVA_TARGET });
  });
}

function acceptsConversationTarget() {
  return Effect.sync(() => {
    expect(
      started.plugin.outbound.resolveTarget({
        to: OUTBOUND_TARGET,
        cfg: makeCfg(),
      }),
    ).toMatchObject({ ok: true, to: OUTBOUND_TARGET });
  });
}

function rejectsEmptyTarget() {
  return Effect.sync(() => {
    const result = started.plugin.outbound.resolveTarget({
      to: "  ",
      cfg: makeCfg(),
    });
    expect(result.ok).toBe(false);
  });
}

function delegatesAgentTarget() {
  return Effect.gen(function* () {
    const result = yield* sendText({
      cfg: makeCfg(),
      to: AGENT_NOVA_TARGET,
      text: AGENT_TEXT,
      accountId: ACCOUNT_ID,
    });
    expectSuccessfulSend(result);
    expect(mockSendToAgent).toHaveBeenCalledWith(AGENT_NOVA_NAME, AGENT_TEXT, {
      replyTo: undefined,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
}

function forwardsAgentReplyTo() {
  return Effect.gen(function* () {
    const result = yield* sendText({
      cfg: makeCfg(),
      to: AGENT_NOVA_TARGET,
      text: AGENT_REPLY_TEXT,
      accountId: ACCOUNT_ID,
      replyToId: PARENT_MESSAGE_ID,
    });
    expectSuccessfulSend(result);
    expect(mockSendToAgent).toHaveBeenCalledWith(
      AGENT_NOVA_NAME,
      AGENT_REPLY_TEXT,
      {
        replyTo: PARENT_MESSAGE_ID,
      },
    );
  });
}

function reportsSendToAgentFailure() {
  return Effect.gen(function* () {
    mockSendToAgent.mockReturnValue(
      Effect.fail(
        new SendToAgentTestFailure({ reason: LOOKUP_FAILED_MESSAGE }),
      ),
    );
    const result = yield* sendText({
      cfg: makeCfg(),
      to: AGENT_NOVA_TARGET,
      text: AGENT_TEXT,
      accountId: ACCOUNT_ID,
    });
    expectFailureMessage(result, LOOKUP_FAILED_MESSAGE);
  });
}

function reportsDisconnectedClient() {
  return Effect.gen(function* () {
    const result = yield* sendText({
      cfg: makeCfg(),
      to: STOP_TARGET,
      text: "hello",
      accountId: "nonexistent-account",
    });
    expectFailureMessage(result, /not connected/i);
  });
}

function reportsSendFailure() {
  return Effect.gen(function* () {
    mockSend.mockReturnValueOnce(serverRejected());
    const result = yield* sendText({
      cfg: makeCfg(),
      to: STOP_TARGET,
      text: "hello",
      accountId: ACCOUNT_ID,
    });
    expectFailureMessage(result, SERVER_REJECTED_MESSAGE);
  });
}

function serverRejected(): Effect.Effect<void, ServiceRpcError> {
  return Effect.fail(
    new RpcServerError({
      code: NON_TASK_CLOSED_CODE,
      message: SERVER_REJECTED_MESSAGE,
    }),
  );
}

function taskClosedIsConsumed() {
  return Effect.gen(function* () {
    mockSend.mockReturnValueOnce(taskClosed());
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    const result = yield* deliverFinal(REPLY_TEXT);
    expect(result).toBe(true);
  });
}

function taskClosed(): Effect.Effect<void, ServiceRpcError> {
  return Effect.fail(
    new RpcServerError({
      code: TaskClosedError.code,
      message: TaskClosedError.message,
    }),
  );
}

function nonTaskClosedFails() {
  return Effect.gen(function* () {
    mockSend.mockReturnValueOnce(
      Effect.fail(
        new RpcServerError({
          code: NON_TASK_CLOSED_CODE,
          message: INTERNAL_SERVER_ERROR_MESSAGE,
        }),
      ),
    );
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    const result = yield* deliverFinal(REPLY_TEXT);
    expect(result).toBe(false);
  });
}

/**
 * Regression test for the r1 lease-consume ordering fix (PR #622 codex P2):
 * a transient `core.sendReply` failure (non-TaskClosed RPC error) MUST leave
 * the per-message `LeaseGuard` unconsumed, so a retried `deliver(...)` call
 * still drives the send path. Without the fix in
 * `openclaw-entry.ts → createLeaseConsumingDeliver` + `sendDeliveredReply`
 * (stamp guard via `Effect.tap` only on successful sendReply), the first
 * failure permanently consumes the guard and the retry short-circuits to
 * `false` without ever re-calling `core.sendReply`.
 *
 * This test exercises that invariant by failing the first send, then making
 * the second send succeed, and asserting `mockSend` was invoked twice and
 * the second deliver returned `true`.
 */
function leaseGuardUnconsumedOnTransientFailure() {
  return Effect.gen(function* () {
    mockSend.mockReturnValueOnce(
      Effect.fail(
        new RpcServerError({
          code: NON_TASK_CLOSED_CODE,
          message: INTERNAL_SERVER_ERROR_MESSAGE,
        }),
      ),
    );
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    const sendBefore = mockSend.mock.calls.length;
    const first = yield* deliverFinal(FIRST_REPLY_TEXT);
    expect(first).toBe(false);
    expect(mockSend.mock.calls.length).toBe(sendBefore + 1);
    // Second deliver: send is now configured to succeed (default
    // `mockSend.mockImplementation(fixture.service.send)` from `startGateway`).
    // The guard MUST NOT have been stamped by the first failure, so this
    // retry exercises the lease and returns true.
    const second = yield* deliverFinal(SECOND_REPLY_TEXT);
    expect(second).toBe(true);
    expect(mockSend.mock.calls.length).toBe(sendBefore + 2);
  });
}

function stopRemovesClient() {
  return Effect.gen(function* () {
    const beforeResult = yield* sendText({
      cfg: makeCfg(),
      to: STOP_TARGET,
      text: BEFORE_STOP_TEXT,
      accountId: ACCOUNT_ID,
    });
    expectSuccessfulSend(beforeResult);
    yield* stopAccount();
    const afterResult = yield* sendText({
      cfg: makeCfg(),
      to: STOP_TARGET,
      text: AFTER_STOP_TEXT,
      accountId: ACCOUNT_ID,
    });
    expectFailureMessage(afterResult, /not connected/i);
  });
}

function plainIdsResolve() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1 })
          .filter((value) => value.trim().length > 0 && !value.includes(":")),
        (target) => {
          const normalizedTarget = target.trim();
          const result = started.plugin.outbound.resolveTarget({
            to: target,
            cfg: makeCfg(),
          });
          expect(result).toMatchObject({ ok: true, to: normalizedTarget });
        },
      ),
    );
  });
}
