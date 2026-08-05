import { live as it } from "@effect/vitest";
import { agentName } from "@moltzap/protocol/testing";
import { Effect, Fiber, Queue } from "effect";
import { describe, expect, vi } from "vitest";
import { createMoltzapChannelPlugin } from "./openclaw-entry.js";
import {
  ACCOUNT_ID,
  CONVERSATION_ID,
  HarnessFixtureError,
  INBOUND_TEXT,
  SENDER_AGENT_ID,
  SENDER_AGENT_NAME,
  cleanUpStart,
  createHarnessFixture,
  firstDispatchCall,
  makeAccount,
  makeConfig,
  offerHarnessTurn,
  runHarnessPromise,
  sendHarnessText,
  startHarnessGateway,
  startPluginHarnessGateway,
  stopHarnessAccount,
  waitForDispatchTimes,
  waitForGatewayStart,
} from "./test-utils/harness-fixture.js";

const IDENTICAL_REPLY = "same successful reply";
const TARGET_AGENT_NAME = agentName("target-agent");
const TARGET_AGENT = `agent:${TARGET_AGENT_NAME}`;
const TARGET_CONVERSATION = `conv:${CONVERSATION_ID}`;
const INITIAL_CONTENT = "begin through Harness";

const injectedIngress = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);

    expect(firstDispatchCall(started.dispatch).ctx).toMatchObject({
      AccountId: ACCOUNT_ID,
      Body: INBOUND_TEXT,
      From: `agent:${SENDER_AGENT_ID}`,
      OriginatingTo: TARGET_CONVERSATION,
      SenderName: SENDER_AGENT_NAME,
    });
    expect(started.harnessClientForAccount).toHaveBeenCalledWith(
      ACCOUNT_ID,
      makeAccount(),
    );
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const identicalSuccessfulRepliesAreSentTwice = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    const deliver = firstDispatchCall(started.dispatch).dispatcherOptions
      .deliver;

    expect(
      yield* runHarnessPromise("deliver first identical reply", () =>
        deliver({ text: IDENTICAL_REPLY }, { kind: "final" }),
      ),
    ).toBe(true);
    expect(
      yield* runHarnessPromise("deliver second identical reply", () =>
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
    new HarnessFixtureError({ message: "first dispatch rejected" }),
  );
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    yield* offerHarnessTurn(fixture);
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 2);
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const agentOutboundStartsConversation = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    const result = yield* sendHarnessText(
      started.plugin,
      TARGET_AGENT,
      INITIAL_CONTENT,
    );

    if (!result.ok) {
      return yield* new HarnessFixtureError({
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
    const result = yield* sendHarnessText(
      started.plugin,
      TARGET_CONVERSATION,
      INITIAL_CONTENT,
    );

    expect(result.ok).toBe(false);
    expect(fixture.startConversation).not.toHaveBeenCalled();
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const stopLeavesClientCallerOwned = () => {
  const fixture = createHarnessFixture();
  const started = startHarnessGateway(fixture);
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    yield* stopHarnessAccount(started.plugin);
    yield* Fiber.join(started.startFiber);

    expect(fixture.callerClose).not.toHaveBeenCalled();
    expect(yield* Queue.isShutdown(fixture.turns)).toBe(false);
    yield* offerHarnessTurn(fixture);
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
    yield* offerHarnessTurn(fixture);
    yield* Effect.yieldNow();
    expect(yield* Queue.size(fixture.turns)).toBe(1);
    expect(started.dispatch).not.toHaveBeenCalled();
  }).pipe(Effect.ensuring(cleanUpStart(started)));
};

const replacingAccountStopsPreviousDrain = () => {
  const firstFixture = createHarnessFixture();
  const secondFixture = createHarnessFixture();
  const harnessClientForAccount = vi
    .fn()
    .mockReturnValueOnce(firstFixture.client)
    .mockReturnValueOnce(secondFixture.client);
  const plugin = createMoltzapChannelPlugin({ harnessClientForAccount });
  const firstStart = startPluginHarnessGateway(plugin);
  let secondStart: ReturnType<typeof startPluginHarnessGateway> | undefined;
  return Effect.gen(function* () {
    yield* waitForGatewayStart(firstStart);
    secondStart = startPluginHarnessGateway(plugin);
    yield* waitForGatewayStart(secondStart);
    yield* Fiber.join(firstStart.startFiber);

    yield* offerHarnessTurn(firstFixture);
    yield* offerHarnessTurn(secondFixture);
    yield* waitForDispatchTimes(secondStart.dispatch, 1);

    expect(firstStart.dispatch).not.toHaveBeenCalled();
    expect(yield* Queue.size(firstFixture.turns)).toBe(1);
    yield* stopHarnessAccount(plugin);
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
  const statusFailure = new HarnessFixtureError({
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
      runHarnessPromise("start gateway with failed status callback", () =>
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

    const result = yield* sendHarnessText(
      plugin,
      TARGET_AGENT,
      INITIAL_CONTENT,
    );
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
    yield* runHarnessPromise("start pre-aborted gateway", () =>
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
    expect(harnessClientForAccount).not.toHaveBeenCalled();
    expect(
      (yield* sendHarnessText(plugin, TARGET_AGENT, INITIAL_CONTENT)).ok,
    ).toBe(false);
  });
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
});
