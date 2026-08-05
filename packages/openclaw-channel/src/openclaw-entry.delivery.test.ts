import { live as it } from "@effect/vitest";
import {
  buildMessage,
  createFakeChannelService,
  flushDispatchChainEffect,
  testAgentId,
  testConversationId,
  testMessageId,
  type FakeChannelService,
} from "@moltzap/client/test-utils";
import type { ServiceRpcError } from "@moltzap/client";
import { agentsList } from "@moltzap/protocol/identity";
import { messagesSend } from "@moltzap/protocol/message";
import type { ConversationId } from "@moltzap/protocol/conversation";
import {
  type ParamsOf,
  type ResultOf,
  type RpcDefinitionAny,
  ForbiddenError,
} from "@moltzap/protocol/rpc";
import { Data, Effect } from "effect";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { createMoltzapChannelPlugin } from "./openclaw-entry.js";

const ACCOUNT_ID = "delivery-test";
const ACCOUNT_AGENT_NAME = "bob-delivery";
const SELF_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440401");
const SENDER_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440402");
const DEFAULT_MESSAGE_ID = testMessageId(
  "550e8400-e29b-41d4-a716-446655440403",
);
const DEFAULT_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440404",
);
const OUTBOUND_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440406",
);
const STOP_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440409",
);
const OUTBOUND_TARGET = `conv:${OUTBOUND_CONVERSATION_ID}`;
const STOP_TARGET = `conv:${STOP_CONVERSATION_ID}`;
const AGENT_NOVA_TARGET = "agent:nova";
const AGENT_NOVA_NAME = "nova";
const TRIGGER_TEXT = "Trigger message";
const REPLY_TEXT = "reply text";
const FIRST_REPLY_TEXT = "first reply";
const SECOND_REPLY_TEXT = "second reply";
const PARTIAL_TEXT = "partial";
const OUTBOUND_TEXT = "Hello from outbound";
const AGENT_TEXT = "Hello nova";
const BEFORE_STOP_TEXT = "before stop";
const AFTER_STOP_TEXT = "after stop";
const LOOKUP_FAILED_MESSAGE = "lookup failed";
const SERVER_REJECTED_MESSAGE = "Server rejected";
const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error";
const DISPATCH_REJECTED_MESSAGE = "dispatch rejected";
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
interface DeliverInput {
  readonly text?: string;
  readonly body?: string;
}
interface DeliverInfo {
  readonly kind?: string;
}
type Deliver = (
  payload: DeliverInput,
  info?: DeliverInfo,
) => PromiseLike<boolean>;
interface DispatchCall {
  readonly dispatcherOptions: {
    readonly deliver: Deliver;
  };
}
type SendFn = (
  conversationId: ConversationId,
  text: string,
) => Effect.Effect<void, ServiceRpcError>;
type SendToAgentFn = (
  agentName: string,
  text: string,
) => Effect.Effect<void, unknown>;
type SendRpcFn = <D extends RpcDefinitionAny>(
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

let started: {
  readonly fixture: FakeChannelService;
  readonly plugin: ReturnType<typeof createMoltzapChannelPlugin>;
};
let abortControllers: AbortController[] = [];
let mockDispatch: ReturnType<typeof vi.fn>;
let mockLogger: ReturnType<typeof testLogger>;

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
    "does not report a rejected inbound dispatch as finished",
    rejectedDispatchIsNotFinished,
  );
  it("each final delivery sends a reply", sendsEachFinalDelivery);
  it("deliver callback returns true for non-final replies", nonFinalIsIgnored);
  it("sendText sends to the right conversation", sendsToConversation);
  it("resolveTarget accepts agent targets", acceptsAgentTarget);
  it("resolveTarget normalizes plain agent names", normalizesPlainAgentName);
  it("resolveTarget accepts conversation IDs", acceptsConversationTarget);
  it("resolveTarget rejects empty strings", rejectsEmptyTarget);
  it("sendText delegates agent targets", delegatesAgentTarget);
  it("sendText delegates plain agent names", delegatesPlainAgentName);
  it("sendText reports sendToAgent failures", reportsSendToAgentFailure);
  it("sendText reports disconnected clients", reportsDisconnectedClient);
  it("sendText reports send failures", reportsSendFailure);
  it("deliver reports transient RPC send failures", sendFailureIsReported);
  it("a later delivery retries after a send failure", retriesAfterSendFailure);
  it("stopAccount removes client from active pool", stopRemovesClient);
  it(
    "property: resolveTarget normalizes generated agent names",
    plainAgentNamesResolve,
  );
});

function startGateway() {
  vi.clearAllMocks();
  mockDispatch = vi.fn().mockResolvedValue({ queuedFinal: true });
  mockLogger = testLogger();
  const fixture = createFakeChannelService({ ownAgentId: SELF_AGENT_ID });
  fixture.state.setConversation(DEFAULT_CONVERSATION_ID, defaultConversation());
  fixture.state.setAgentName(SENDER_AGENT_ID, "Atlas");
  const service = createTestService(fixture);
  const plugin = createMoltzapChannelPlugin({
    createService: () => service,
  });
  const abortController = new AbortController();
  abortControllers.push(abortController);
  Effect.runFork(
    Effect.tryPromise({
      try: () =>
        plugin.gateway.startAccount({
          cfg: makeCfg(),
          accountId: ACCOUNT_ID,
          account: makeAccount(),
          abortSignal: abortController.signal,
          log: mockLogger,
          setStatus: vi.fn(),
          channelRuntime: {
            reply: {
              dispatchReplyWithBufferedBlockDispatcher: mockDispatch,
            },
          },
        }),
      catch: (cause) => cause,
    }),
  );
  return { fixture, plugin };
}

function createTestService(fixture: FakeChannelService): TestService {
  mockSend.mockImplementation(fixture.service.send.bind(fixture.service));
  mockSendToAgent.mockReturnValue(Effect.void);
  return {
    ...fixture.service,
    send: mockSend,
    sendRpc: sendRpcDefault,
    sendToAgent: mockSendToAgent,
  };
}

function sendRpcDefault<D extends RpcDefinitionAny>(
  definition: D,
): Effect.Effect<ResultOf<D>, ServiceRpcError> {
  if (definition.name === agentsList.name) {
    return Effect.succeed(
      rpcResult<D>({
        agents: [{ id: SENDER_AGENT_ID, name: "Atlas" }],
      }),
    );
  }
  if (definition.name === messagesSend.name) {
    return Effect.succeed(rpcResult<D>({ message: { id: "sent-1" } }));
  }
  return Effect.succeed(rpcResult<D>({}));
}

function rpcResult<D extends RpcDefinitionAny>(value: unknown): ResultOf<D> {
  return /* Safe because each test branch matches the selected RPC definition. */ value as ResultOf<D>;
}

function makeAccount() {
  return {
    id: ACCOUNT_ID,
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

function emitMessage(overrides: Parameters<typeof buildMessage>[0] = {}) {
  return Effect.gen(function* () {
    started.fixture.emit.message(makeDeliveryMessage(overrides));
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
  return /* Safe because the test fixture establishes this asserted shape. */ mockDispatch
    .mock.calls[0]?.[0] as DispatchCall;
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
  if (result.ok) {
    return;
  }
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

function rejectedDispatchIsNotFinished() {
  return Effect.gen(function* () {
    mockDispatch.mockRejectedValueOnce(new Error(DISPATCH_REJECTED_MESSAGE));
    yield* emitMessage();
    yield* waitForExpectation(() => {
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(DISPATCH_REJECTED_MESSAGE),
      );
    }, "dispatch error log");
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("dispatch finished"),
    );
  });
}

function sendsEachFinalDelivery() {
  return Effect.gen(function* () {
    yield* emitMessage();
    yield* waitForDispatchTimes(1);
    const sendBefore = mockSend.mock.calls.length;
    const first = yield* deliverFinal(FIRST_REPLY_TEXT);
    const sendAfterFirst = mockSend.mock.calls.length;
    const second = yield* deliverFinal(SECOND_REPLY_TEXT);
    expect(first).toBe(true);
    expect(sendAfterFirst).toBe(sendBefore + 1);
    expect(second).toBe(true);
    expect(mockSend.mock.calls.length).toBe(sendAfterFirst + 1);
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
      OUTBOUND_CONVERSATION_ID,
      OUTBOUND_TEXT,
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

function normalizesPlainAgentName() {
  return Effect.sync(() => {
    expect(
      started.plugin.outbound.resolveTarget({
        to: AGENT_NOVA_NAME,
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
    expect(mockSendToAgent).toHaveBeenCalledWith(AGENT_NOVA_NAME, AGENT_TEXT);
    expect(mockSend).not.toHaveBeenCalled();
  });
}

function delegatesPlainAgentName() {
  return Effect.gen(function* () {
    const result = yield* sendText({
      cfg: makeCfg(),
      to: AGENT_NOVA_NAME,
      text: AGENT_TEXT,
      accountId: ACCOUNT_ID,
    });
    expectSuccessfulSend(result);
    expect(mockSendToAgent).toHaveBeenCalledWith(AGENT_NOVA_NAME, AGENT_TEXT);
    expect(mockSend).not.toHaveBeenCalled();
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
    new ForbiddenError({
      message: SERVER_REJECTED_MESSAGE,
    }),
  );
}

function sendFailureIsReported() {
  return Effect.gen(function* () {
    mockSend.mockReturnValueOnce(
      Effect.fail(
        new ForbiddenError({
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

function retriesAfterSendFailure() {
  return Effect.gen(function* () {
    mockSend.mockReturnValueOnce(
      Effect.fail(
        new ForbiddenError({
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

function plainAgentNamesResolve() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/),
        (target) => {
          const result = started.plugin.outbound.resolveTarget({
            to: target,
            cfg: makeCfg(),
          });
          expect(result).toMatchObject({ ok: true, to: `agent:${target}` });
        },
      ),
    );
  });
}
