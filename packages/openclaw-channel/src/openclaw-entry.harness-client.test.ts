import { live as it } from "@effect/vitest";
import type {
  HarnessClientService,
  HarnessTurn,
} from "@moltzap/client/harness-client";
import {
  createFakeChannelService,
  testAgentId,
  testConversationId,
  testMessageId,
} from "@moltzap/client/test-utils";
import { agentName } from "@moltzap/protocol/testing";
import { Data, Effect, Fiber, Queue, Stream } from "effect";
import { describe, expect, vi } from "vitest";
import { createMoltzapChannelPlugin } from "./openclaw-entry.js";

const ACCOUNT_ID = "harness-account";
const ACCOUNT_AGENT_NAME = "harness-agent";
const SELF_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440801");
const SENDER_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440802");
const CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440803",
);
const MESSAGE_ID = testMessageId("550e8400-e29b-41d4-a716-446655440804");
const STARTED_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440805",
);
const CREATED_AT = "2026-08-04T00:00:00.000Z";
const INBOUND_TEXT = "injected inbound";
const IDENTICAL_REPLY = "same successful reply";
const TARGET_AGENT_NAME = agentName("target-agent");
const TARGET_AGENT = `agent:${TARGET_AGENT_NAME}`;
const TARGET_CONVERSATION = `conv:${CONVERSATION_ID}`;
const INITIAL_CONTENT = "begin through Harness";

type StartConversation = HarnessClientService["startConversation"];
type TurnReply = HarnessTurn["reply"];
type Plugin = ReturnType<typeof createMoltzapChannelPlugin>;
type Dispatch = ReturnType<typeof vi.fn>;

interface DispatchCall {
  readonly ctx: Record<string, unknown>;
  readonly dispatcherOptions: {
    readonly deliver: (
      payload: { readonly text?: string; readonly body?: string },
      info?: { readonly kind?: string },
    ) => PromiseLike<boolean>;
  };
}

class HarnessClientTestError extends Data.TaggedError(
  "HarnessClientTestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class UnexpectedLegacyConstructionError extends Data.TaggedError(
  "UnexpectedLegacyConstructionError",
)<Record<never, never>> {}

function makeAccount() {
  return { id: ACCOUNT_ID, agentName: ACCOUNT_AGENT_NAME };
}

function makeConfig() {
  return {
    channels: {
      moltzap: {
        accounts: [makeAccount()],
      },
    },
  };
}

function makeTurn(reply: TurnReply): HarnessTurn {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    sender: { id: SENDER_AGENT_ID, name: "sender-agent" },
    text: INBOUND_TEXT,
    isFromMe: false,
    createdAt: CREATED_AT,
    conversationMeta: {
      type: "dm",
      participants: [`agent:${SELF_AGENT_ID}`, `agent:${SENDER_AGENT_ID}`],
    },
    contextBlocks: {},
    reply,
  };
}

function createHarnessFixture() {
  const turns = Effect.runSync(Queue.unbounded<HarnessTurn>());
  const reply = vi.fn<TurnReply>().mockReturnValue(Effect.void);
  const startConversation = vi.fn<StartConversation>().mockReturnValue(
    Effect.succeed({
      id: STARTED_CONVERSATION_ID,
      createdBy: SELF_AGENT_ID,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      participants: [SELF_AGENT_ID, SENDER_AGENT_ID],
    }),
  );
  const callerClose = vi.fn();
  const client: HarnessClientService & { readonly close: () => void } = {
    agentId: SELF_AGENT_ID,
    startConversation,
    turns: Stream.fromQueue(turns),
    close: callerClose,
  };
  return { callerClose, client, reply, startConversation, turns };
}

function startPluginHarnessGateway(plugin: Plugin, setStatus?: Dispatch) {
  const dispatch = vi.fn().mockResolvedValue({ queuedFinal: true });
  const reportStatus = setStatus ?? vi.fn();
  const abortController = new AbortController();
  const startFiber = Effect.runFork(
    runPromise("start Harness gateway", () =>
      plugin.gateway.startAccount({
        cfg: makeConfig(),
        accountId: ACCOUNT_ID,
        account: makeAccount(),
        abortSignal: abortController.signal,
        setStatus: reportStatus,
        channelRuntime: {
          reply: { dispatchReplyWithBufferedBlockDispatcher: dispatch },
        },
      }),
    ),
  );
  return {
    abortController,
    dispatch,
    plugin,
    setStatus: reportStatus,
    startFiber,
  };
}

function startHarnessGateway(fixture: ReturnType<typeof createHarnessFixture>) {
  const createService = vi.fn(() => {
    throw new UnexpectedLegacyConstructionError();
  });
  const harnessClientForAccount = vi.fn(() => fixture.client);
  const plugin = createMoltzapChannelPlugin({
    createService,
    harnessClientForAccount,
  });
  return {
    ...startPluginHarnessGateway(plugin),
    createService,
    harnessClientForAccount,
  };
}

function runPromise<A>(
  message: string,
  operation: () => PromiseLike<A>,
): Effect.Effect<A, HarnessClientTestError> {
  return Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new HarnessClientTestError({ message, cause }),
  });
}

function waitForExpectation(assertion: () => void, message: string) {
  return runPromise(message, () => vi.waitFor(assertion));
}

function waitForGatewayStart(started: { readonly setStatus: Dispatch }) {
  return waitForExpectation(() => {
    expect(started.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID, connected: true }),
    );
  }, "wait for Harness gateway start");
}

function firstDispatchCall(dispatch: Dispatch): DispatchCall {
  return /* Safe because the fixture waits until dispatch has one call. */ dispatch
    .mock.calls[0]?.[0] as DispatchCall;
}

function sendText(plugin: Plugin, to: string, text: string) {
  return runPromise("send Harness text", () =>
    plugin.outbound.sendText({
      cfg: makeConfig(),
      accountId: ACCOUNT_ID,
      to,
      text,
    }),
  );
}

function stopAccount(plugin: Plugin) {
  return runPromise("stop Harness account", () =>
    plugin.gateway.stopAccount({ accountId: ACCOUNT_ID }),
  );
}

function cleanUpStart(started: ReturnType<typeof startPluginHarnessGateway>) {
  return Effect.sync(() => {
    started.abortController.abort();
  }).pipe(Effect.zipRight(Fiber.interrupt(started.startFiber)), Effect.asVoid);
}

const injectedIngress = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    yield* Queue.offer(fixture.turns, makeTurn(fixture.reply));
    yield* waitForExpectation(() => {
      expect(started.dispatch).toHaveBeenCalledTimes(1);
    }, "wait for injected dispatch");

    expect(firstDispatchCall(started.dispatch).ctx).toMatchObject({
      AccountId: ACCOUNT_ID,
      Body: INBOUND_TEXT,
      From: `agent:${SENDER_AGENT_ID}`,
      OriginatingTo: TARGET_CONVERSATION,
      SenderName: "sender-agent",
    });
    expect(started.harnessClientForAccount).toHaveBeenCalledWith(
      ACCOUNT_ID,
      makeAccount(),
    );
    expect(started.createService).not.toHaveBeenCalled();
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const identicalSuccessfulRepliesAreSentTwice = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    yield* Queue.offer(fixture.turns, makeTurn(fixture.reply));
    yield* waitForExpectation(() => {
      expect(started.dispatch).toHaveBeenCalledTimes(1);
    }, "wait for reply dispatch");
    const deliver = firstDispatchCall(started.dispatch).dispatcherOptions
      .deliver;

    expect(
      yield* runPromise("deliver first identical reply", () =>
        deliver({ text: IDENTICAL_REPLY }, { kind: "final" }),
      ),
    ).toBe(true);
    expect(
      yield* runPromise("deliver second identical reply", () =>
        deliver({ text: IDENTICAL_REPLY }, { kind: "final" }),
      ),
    ).toBe(true);
    expect(fixture.reply.mock.calls).toEqual([
      [IDENTICAL_REPLY],
      [IDENTICAL_REPLY],
    ]);
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const failedTurnDoesNotStopDrain = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  started.dispatch.mockRejectedValueOnce(
    new HarnessClientTestError({ message: "first dispatch rejected" }),
  );
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    yield* Queue.offer(fixture.turns, makeTurn(fixture.reply));
    yield* Queue.offer(fixture.turns, makeTurn(fixture.reply));
    yield* waitForExpectation(() => {
      expect(started.dispatch).toHaveBeenCalledTimes(2);
    }, "wait for dispatch after one rejected turn");
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const agentOutboundStartsConversation = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    const result = yield* sendText(
      started.plugin,
      TARGET_AGENT,
      INITIAL_CONTENT,
    );

    if (!result.ok) {
      return yield* new HarnessClientTestError({
        message: result.error.message,
        cause: result.error,
      });
    }
    expect(fixture.startConversation).toHaveBeenCalledExactlyOnceWith(
      [TARGET_AGENT_NAME],
      INITIAL_CONTENT,
    );
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const conversationOutboundHasNoFallback = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    const result = yield* sendText(
      started.plugin,
      TARGET_CONVERSATION,
      INITIAL_CONTENT,
    );

    expect(result.ok).toBe(false);
    expect(fixture.startConversation).not.toHaveBeenCalled();
    expect(started.createService).not.toHaveBeenCalled();
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const stopLeavesClientCallerOwned = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    yield* stopAccount(started.plugin);
    yield* Fiber.join(started.startFiber);

    expect(fixture.callerClose).not.toHaveBeenCalled();
    expect(yield* Queue.isShutdown(fixture.turns)).toBe(false);
    yield* Queue.offer(fixture.turns, makeTurn(fixture.reply));
    yield* Effect.yieldNow();
    expect(yield* Queue.size(fixture.turns)).toBe(1);
    expect(started.dispatch).not.toHaveBeenCalled();
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const abortLeavesClientCallerOwned = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    started.abortController.abort();
    yield* Fiber.join(started.startFiber);

    expect(fixture.callerClose).not.toHaveBeenCalled();
    expect(yield* Queue.isShutdown(fixture.turns)).toBe(false);
    yield* Queue.offer(fixture.turns, makeTurn(fixture.reply));
    yield* Effect.yieldNow();
    expect(yield* Queue.size(fixture.turns)).toBe(1);
    expect(started.dispatch).not.toHaveBeenCalled();
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const replacingAccountStopsPreviousDrain = () => {
  const firstFixture = createHarnessFixture();
  const secondFixture = createHarnessFixture();
  const createService = vi.fn(() => {
    throw new UnexpectedLegacyConstructionError();
  });
  const harnessClientForAccount = vi
    .fn()
    .mockReturnValueOnce(firstFixture.client)
    .mockReturnValueOnce(secondFixture.client);
  const plugin = createMoltzapChannelPlugin({
    createService,
    harnessClientForAccount,
  });
  const firstStart = startPluginHarnessGateway(plugin);
  let secondStart: ReturnType<typeof startPluginHarnessGateway> | undefined;
  return Effect.gen(function* () {
    yield* waitForGatewayStart(firstStart);
    secondStart = startPluginHarnessGateway(plugin);
    yield* waitForGatewayStart(secondStart);
    yield* Fiber.join(firstStart.startFiber);

    yield* Queue.offer(firstFixture.turns, makeTurn(firstFixture.reply));
    yield* Queue.offer(secondFixture.turns, makeTurn(secondFixture.reply));
    yield* waitForExpectation(() => {
      expect(secondStart?.dispatch).toHaveBeenCalledTimes(1);
    }, "wait for replacement gateway dispatch");

    expect(firstStart.dispatch).not.toHaveBeenCalled();
    expect(yield* Queue.size(firstFixture.turns)).toBe(1);
    expect(createService).not.toHaveBeenCalled();
    yield* stopAccount(plugin);
    yield* Fiber.join(secondStart.startFiber);
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        secondStart === undefined
          ? cleanUpStart(firstStart)
          : Effect.all([cleanUpStart(firstStart), cleanUpStart(secondStart)], {
              discard: true,
            }),
      ),
    ),
  );
};

const statusFailureReleasesGateway = () => {
  const fixture = createHarnessFixture();
  const statusFailure = new HarnessClientTestError({
    message: "status callback failed",
  });
  const setStatus = vi.fn(() => {
    throw statusFailure;
  });
  const plugin = createMoltzapChannelPlugin({
    harnessClientForAccount: () => fixture.client,
  });
  const abortController = new AbortController();
  return Effect.gen(function* () {
    yield* Effect.flip(
      runPromise("start gateway with failed status callback", () =>
        plugin.gateway.startAccount({
          cfg: makeConfig(),
          accountId: ACCOUNT_ID,
          account: makeAccount(),
          abortSignal: abortController.signal,
          setStatus,
          channelRuntime: {
            reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
          },
        }),
      ),
    );

    const result = yield* sendText(plugin, TARGET_AGENT, INITIAL_CONTENT);
    expect(result.ok).toBe(false);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(fixture.callerClose).not.toHaveBeenCalled();
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        abortController.abort();
      }),
    ),
  );
};

const preAbortedStartDoesNotPublishConnected = () => {
  const fixture = createHarnessFixture();
  const setStatus = vi.fn();
  const harnessClientForAccount = vi.fn(() => fixture.client);
  const plugin = createMoltzapChannelPlugin({ harnessClientForAccount });
  const abortController = new AbortController();
  abortController.abort();
  return Effect.gen(function* () {
    yield* runPromise("start pre-aborted gateway", () =>
      plugin.gateway.startAccount({
        cfg: makeConfig(),
        accountId: ACCOUNT_ID,
        account: makeAccount(),
        abortSignal: abortController.signal,
        setStatus,
        channelRuntime: {
          reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
        },
      }),
    );

    expect(setStatus).not.toHaveBeenCalled();
    expect(harnessClientForAccount).toHaveBeenCalledExactlyOnceWith(
      ACCOUNT_ID,
      makeAccount(),
    );
    expect((yield* sendText(plugin, TARGET_AGENT, INITIAL_CONTENT)).ok).toBe(
      false,
    );
  });
};

const staleLegacyAbortKeepsReplacement = () => {
  const firstFixture = createFakeChannelService({
    ownAgentId: SELF_AGENT_ID,
  });
  const secondFixture = createFakeChannelService({
    ownAgentId: SELF_AGENT_ID,
  });
  const createService = vi
    .fn()
    .mockReturnValueOnce(firstFixture.service)
    .mockReturnValueOnce(secondFixture.service);
  const plugin = createMoltzapChannelPlugin({ createService });
  const firstStart = startPluginHarnessGateway(plugin);
  let secondStart: ReturnType<typeof startPluginHarnessGateway> | undefined;
  return Effect.gen(function* () {
    yield* waitForGatewayStart(firstStart);
    secondStart = startPluginHarnessGateway(plugin);
    yield* waitForGatewayStart(secondStart);

    expect(firstFixture.state.closeCalls.count).toBe(1);
    firstStart.abortController.abort();
    yield* Fiber.join(firstStart.startFiber);

    const result = yield* sendText(
      plugin,
      TARGET_CONVERSATION,
      INITIAL_CONTENT,
    );
    expect(result.ok).toBe(true);
    expect(secondFixture.state.sent).toHaveLength(1);
    yield* stopAccount(plugin);
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        secondStart === undefined
          ? cleanUpStart(firstStart)
          : Effect.all([cleanUpStart(firstStart), cleanUpStart(secondStart)], {
              discard: true,
            }),
      ),
    ),
  );
};

const replacingLegacyWithHarnessLeavesNoFallback = () => {
  const legacyFixture = createFakeChannelService({
    ownAgentId: SELF_AGENT_ID,
  });
  const harnessFixture = createHarnessFixture();
  let selectHarness = false;
  const plugin = createMoltzapChannelPlugin({
    createService: () => legacyFixture.service,
    harnessClientForAccount: () =>
      selectHarness ? harnessFixture.client : undefined,
  });
  const legacyStart = startPluginHarnessGateway(plugin);
  let harnessStart: ReturnType<typeof startPluginHarnessGateway> | undefined;
  return Effect.gen(function* () {
    yield* waitForGatewayStart(legacyStart);
    selectHarness = true;
    harnessStart = startPluginHarnessGateway(plugin);
    yield* waitForGatewayStart(harnessStart);

    expect(legacyFixture.state.closeCalls.count).toBe(1);
    legacyStart.abortController.abort();
    yield* Fiber.join(legacyStart.startFiber);
    yield* stopAccount(plugin);
    yield* Fiber.join(harnessStart.startFiber);

    const result = yield* sendText(
      plugin,
      TARGET_CONVERSATION,
      INITIAL_CONTENT,
    );
    expect(result.ok).toBe(false);
    expect(legacyFixture.state.sent).toEqual([]);
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        harnessStart === undefined
          ? cleanUpStart(legacyStart)
          : Effect.all(
              [cleanUpStart(legacyStart), cleanUpStart(harnessStart)],
              { discard: true },
            ),
      ),
    ),
  );
};

// @agent-code-guard/regression-only: these examples pin the caller-owned HarnessClient seam at OpenClaw's fixed gateway contract.
describe("OpenClaw HarnessClient gateway", () => {
  it("dispatches turns from an injected client", injectedIngress);
  it(
    "sends two identical successful replies twice",
    identicalSuccessfulRepliesAreSentTwice,
  );
  it("continues after one turn dispatch fails", failedTurnDoesNotStopDrain);
  it(
    "starts a conversation for agent outbound",
    agentOutboundStartsConversation,
  );
  it(
    "rejects conversation outbound without fallback",
    conversationOutboundHasNoFallback,
  );
  it("leaves the client caller-owned on stop", stopLeavesClientCallerOwned);
  it("leaves the client caller-owned on abort", abortLeavesClientCallerOwned);
  it(
    "stops the previous drain when an account restarts",
    replacingAccountStopsPreviousDrain,
  );
  it(
    "releases the gateway when status reporting fails",
    statusFailureReleasesGateway,
  );
  it(
    "does not publish connected for a pre-aborted start",
    preAbortedStartDoesNotPublishConnected,
  );
  it(
    "keeps a replacement legacy account after a stale abort",
    staleLegacyAbortKeepsReplacement,
  );
  it(
    "removes legacy fallback when Harness replaces an account",
    replacingLegacyWithHarnessLeavesNoFallback,
  );
});
