import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  CONVERSATION_ID,
  HarnessFixtureError,
  cleanUpStart,
  createHarnessFixture,
  firstDispatchCall,
  makeConfig,
  offerHarnessTurn,
  runHarnessPromise,
  sendHarnessText,
  startHarnessGateway,
  stopHarnessAccount,
  waitForDispatchTimes,
  waitForGatewayStart,
  waitForHarnessExpectation,
  type HarnessFixture,
} from "./test-utils/harness-fixture.js";

const AGENT_NOVA_TARGET = "agent:nova";
const AGENT_NOVA_NAME = "nova";
const CONVERSATION_TARGET = `conv:${CONVERSATION_ID}`;
const UNKNOWN_ACCOUNT_ID = "nonexistent-account";
const REPLY_TEXT = "reply text";
const FIRST_REPLY_TEXT = "first reply";
const SECOND_REPLY_TEXT = "second reply";
const PARTIAL_TEXT = "partial";
const AGENT_TEXT = "Hello nova";
const BEFORE_STOP_TEXT = "before stop";
const AFTER_STOP_TEXT = "after stop";
const START_CONVERSATION_REJECTED_MESSAGE = "Server rejected";
const REPLY_REJECTED_MESSAGE = "Internal server error";
const DISPATCH_REJECTED_MESSAGE = "dispatch rejected";
const FINAL_KIND = "final";
const TOOL_KIND = "tool";

interface DeliverInput {
  readonly text?: string;
  readonly body?: string;
}

let fixture: HarnessFixture;
let started: ReturnType<typeof startHarnessGateway>;
let logger: ReturnType<typeof testLogger>;

beforeEach(() => {
  logger = testLogger();
  fixture = createHarnessFixture();
  started = startHarnessGateway(fixture, { log: logger });
});

afterEach(() => Effect.runPromise(cleanUpStart(started)));

describe("Flow 6: Outbound delivery - deliver callback + sendText", () => {
  it("deliver callback returns true", deliverReturnsTrue);
  it(
    "does not report a rejected inbound dispatch as finished",
    rejectedDispatchIsNotFinished,
  );
  it("each final delivery sends a reply", sendsEachFinalDelivery);
  it("deliver callback returns true for non-final replies", nonFinalIsIgnored);
  it("resolveTarget accepts agent targets", acceptsAgentTarget);
  it("resolveTarget normalizes plain agent names", normalizesPlainAgentName);
  it("resolveTarget accepts conversation IDs", acceptsConversationTarget);
  it("resolveTarget rejects empty strings", rejectsEmptyTarget);
  it(
    "sendText starts a conversation for a plain agent name",
    startsConversationForPlainAgentName,
  );
  it("sendText reports disconnected clients", reportsDisconnectedClient);
  it(
    "sendText reports startConversation failures",
    reportsStartConversationFailure,
  );
  it("deliver reports a rejected turn reply", replyFailureIsReported);
  it(
    "a later delivery retries after a reply failure",
    retriesAfterReplyFailure,
  );
  it("stopAccount removes client from active pool", stopRemovesClient);
  it(
    "property: resolveTarget normalizes generated agent names",
    plainAgentNamesResolve,
  );
});

function testLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function deliverFinal(text: string) {
  return deliver({ text }, FINAL_KIND);
}

function deliver(payload: DeliverInput, kind: string) {
  const delivery = firstDispatchCall(started.dispatch).dispatcherOptions
    .deliver;
  return runHarnessPromise("deliver failed", () => delivery(payload, { kind }));
}

function expectFailureMessage(
  result: { readonly ok: boolean; readonly error?: Error },
  expectedMessage: string | RegExp,
): void {
  expect(result.ok).toBe(false);
  if (typeof expectedMessage === "string") {
    expect(result.error?.message).toBe(expectedMessage);
    return;
  }
  expect(result.error?.message).toMatch(expectedMessage);
}

function deliverReturnsTrue() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(yield* deliverFinal(REPLY_TEXT)).toBe(true);
  });
}

function rejectedDispatchIsNotFinished() {
  return Effect.gen(function* () {
    started.dispatch.mockRejectedValueOnce(
      new HarnessFixtureError({ message: DISPATCH_REJECTED_MESSAGE }),
    );
    yield* offerHarnessTurn(fixture);
    yield* waitForHarnessExpectation(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(DISPATCH_REJECTED_MESSAGE),
      );
    }, "wait for dispatch error log");
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("dispatch finished"),
    );
  });
}

function sendsEachFinalDelivery() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(yield* deliverFinal(FIRST_REPLY_TEXT)).toBe(true);
    expect(yield* deliverFinal(SECOND_REPLY_TEXT)).toBe(true);
    expect(fixture.reply.mock.calls).toEqual([
      [FIRST_REPLY_TEXT],
      [SECOND_REPLY_TEXT],
    ]);
  });
}

function nonFinalIsIgnored() {
  return Effect.gen(function* () {
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(yield* deliver({ text: PARTIAL_TEXT }, TOOL_KIND)).toBe(true);
    expect(fixture.reply).not.toHaveBeenCalled();
  });
}

function acceptsAgentTarget() {
  return Effect.sync(() => {
    expect(
      started.plugin.outbound.resolveTarget({
        to: AGENT_NOVA_TARGET,
        cfg: makeConfig(),
      }),
    ).toMatchObject({ ok: true, to: AGENT_NOVA_TARGET });
  });
}

function normalizesPlainAgentName() {
  return Effect.sync(() => {
    expect(
      started.plugin.outbound.resolveTarget({
        to: AGENT_NOVA_NAME,
        cfg: makeConfig(),
      }),
    ).toMatchObject({ ok: true, to: AGENT_NOVA_TARGET });
  });
}

// Inbound turns are labelled `conv:<id>`, so target parsing still accepts the
// prefix even though the harness surface has no proactive send into one.
function acceptsConversationTarget() {
  return Effect.sync(() => {
    expect(
      started.plugin.outbound.resolveTarget({
        to: CONVERSATION_TARGET,
        cfg: makeConfig(),
      }),
    ).toMatchObject({ ok: true, to: CONVERSATION_TARGET });
  });
}

function rejectsEmptyTarget() {
  return Effect.sync(() => {
    expect(
      started.plugin.outbound.resolveTarget({ to: "  ", cfg: makeConfig() }).ok,
    ).toBe(false);
  });
}

function startsConversationForPlainAgentName() {
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    const result = yield* sendHarnessText(
      started.plugin,
      AGENT_NOVA_NAME,
      AGENT_TEXT,
    );
    expect(result.ok).toBe(true);
    expect(fixture.startConversation).toHaveBeenCalledExactlyOnceWith(
      [AGENT_NOVA_NAME],
      AGENT_TEXT,
    );
  });
}

function reportsDisconnectedClient() {
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    const result = yield* sendHarnessText(
      started.plugin,
      AGENT_NOVA_TARGET,
      AGENT_TEXT,
      UNKNOWN_ACCOUNT_ID,
    );
    expectFailureMessage(result, /not connected/i);
  });
}

function reportsStartConversationFailure() {
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    fixture.startConversation.mockReturnValueOnce(
      Effect.fail(
        new HarnessFixtureError({
          message: START_CONVERSATION_REJECTED_MESSAGE,
        }),
      ),
    );
    const result = yield* sendHarnessText(
      started.plugin,
      AGENT_NOVA_TARGET,
      AGENT_TEXT,
    );
    expectFailureMessage(result, START_CONVERSATION_REJECTED_MESSAGE);
  });
}

function replyFailureIsReported() {
  return Effect.gen(function* () {
    fixture.reply.mockReturnValueOnce(
      Effect.fail(new HarnessFixtureError({ message: REPLY_REJECTED_MESSAGE })),
    );
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(yield* deliverFinal(REPLY_TEXT)).toBe(false);
  });
}

function retriesAfterReplyFailure() {
  return Effect.gen(function* () {
    fixture.reply.mockReturnValueOnce(
      Effect.fail(new HarnessFixtureError({ message: REPLY_REJECTED_MESSAGE })),
    );
    yield* offerHarnessTurn(fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(yield* deliverFinal(FIRST_REPLY_TEXT)).toBe(false);
    expect(yield* deliverFinal(SECOND_REPLY_TEXT)).toBe(true);
    expect(fixture.reply.mock.calls).toEqual([
      [FIRST_REPLY_TEXT],
      [SECOND_REPLY_TEXT],
    ]);
  });
}

function stopRemovesClient() {
  return Effect.gen(function* () {
    yield* waitForGatewayStart(started);
    const beforeResult = yield* sendHarnessText(
      started.plugin,
      AGENT_NOVA_TARGET,
      BEFORE_STOP_TEXT,
    );
    expect(beforeResult.ok).toBe(true);
    yield* stopHarnessAccount(started.plugin);
    const afterResult = yield* sendHarnessText(
      started.plugin,
      AGENT_NOVA_TARGET,
      AFTER_STOP_TEXT,
    );
    expectFailureMessage(afterResult, /not connected/i);
  });
}

function plainAgentNamesResolve() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/),
        (target) => {
          expect(
            started.plugin.outbound.resolveTarget({
              to: target,
              cfg: makeConfig(),
            }),
          ).toMatchObject({ ok: true, to: `agent:${target}` });
        },
      ),
    );
  });
}
