/**
 * Shared OpenClaw gateway fixture.
 *
 * The plugin reaches its client only through the caller-owned
 * `harnessClientForAccount` seam, so every gateway suite needs the same three
 * things: an injected client whose turn stream the test drives, OpenClaw's
 * fixed `startAccount` argument shape, and a teardown that leaves the client
 * untouched. They live here so each suite asserts behaviour instead of
 * rebuilding the seam.
 */

import type {
  HarnessClientService,
  HarnessTurn,
} from "@moltzap/client/harness-client";
import {
  testAgentId,
  testConversationId,
  testMessageId,
} from "@moltzap/client/test-utils";
import { Data, Effect, Fiber, Queue, Stream } from "effect";
import { expect, vi } from "vitest";
import {
  createMoltzapChannelPlugin,
  type MoltzapChannelPlugin,
} from "../openclaw-entry.js";

/** OpenClaw account slot; the id also names the MoltZap profile. */
export const ACCOUNT_ID = "harness-account";

/** Configured agent name, reported to OpenClaw as the inbound `To` field. */
export const ACCOUNT_AGENT_NAME = "harness-agent";

/** Identity the injected client reports as its own. */
export const SELF_AGENT_ID = testAgentId(
  "550e8400-e29b-41d4-a716-446655440801",
);

/** Identity that authors every fixture turn. */
export const SENDER_AGENT_ID = testAgentId(
  "550e8400-e29b-41d4-a716-446655440802",
);

/** Presentation name the turn already carries for its sender. */
export const SENDER_AGENT_NAME = "sender-agent";

/** Conversation every fixture turn arrives on. */
export const CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440803",
);

/** Fixed timestamp so a turn never depends on wall-clock time. */
export const CREATED_AT = "2026-08-04T00:00:00.000Z";

/** Body a fixture turn carries unless the caller overrides it. */
export const INBOUND_TEXT = "injected inbound";

const MESSAGE_ID = testMessageId("550e8400-e29b-41d4-a716-446655440804");
const STARTED_CONVERSATION_ID = testConversationId(
  "550e8400-e29b-41d4-a716-446655440805",
);

type StartConversation = HarnessClientService["startConversation"];
type TurnReply = HarnessTurn["reply"];
type Dispatch = ReturnType<typeof vi.fn>;
type SetStatus = ReturnType<
  typeof vi.fn<(next: Record<string, unknown>) => void>
>;

interface HarnessGatewayLogger {
  readonly info?: (...args: unknown[]) => void;
  readonly warn?: (...args: unknown[]) => void;
  readonly error?: (...args: unknown[]) => void;
  readonly debug?: (...args: unknown[]) => void;
}

interface HarnessGatewayOverrides {
  readonly log?: HarnessGatewayLogger;
  /** Starts without the reply dispatcher, so inbound turns have no sink. */
  readonly withoutChannelRuntime?: boolean;
}

interface StartedHarnessGateway {
  readonly abortController: AbortController;
  readonly dispatch: Dispatch;
  readonly plugin: MoltzapChannelPlugin;
  readonly setStatus: SetStatus;
  readonly startFiber: Fiber.RuntimeFiber<void, HarnessFixtureError>;
}

interface StartedInjectedHarnessGateway extends StartedHarnessGateway {
  readonly harnessClientForAccount: ReturnType<
    typeof vi.fn<() => InjectedHarnessClient>
  >;
}

type InjectedHarnessClient = HarnessClientService & {
  readonly close: () => void;
};

/** OpenClaw's send-text verdict, named so the fixture can surface it. */
type SendTextResult = Awaited<
  ReturnType<MoltzapChannelPlugin["outbound"]["sendText"]>
>;

interface HarnessDispatchCall {
  readonly ctx: Record<string, unknown>;
  readonly cfg: unknown;
  readonly dispatcherOptions: {
    readonly deliver: (
      payload: { readonly text?: string; readonly body?: string },
      info?: { readonly kind?: string },
    ) => PromiseLike<boolean>;
  };
}

/** Failure raised when a fixture-driven Promise boundary rejects. */
export class HarnessFixtureError extends Data.TaggedError(
  "HarnessFixtureError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Builds the configured OpenClaw account entry.
 * @param id Account id, which is also the MoltZap profile name.
 * @returns The account entry OpenClaw passes to `startAccount`.
 */
export function makeAccount(id: string = ACCOUNT_ID) {
  return { id, agentName: ACCOUNT_AGENT_NAME };
}

/**
 * Builds the OpenClaw config holding exactly one MoltZap account.
 * @param id Account id to configure.
 * @returns The OpenClaw config value.
 */
export function makeConfig(id: string = ACCOUNT_ID) {
  return {
    channels: {
      moltzap: {
        accounts: [makeAccount(id)],
      },
    },
  };
}

/**
 * Wraps a Promise-returning OpenClaw boundary call as an Effect.
 * @param message Label attached to a rejection.
 * @param operation The boundary call.
 * @returns An Effect that fails with {@link HarnessFixtureError}.
 * @failure HarnessFixtureError when the boundary call rejects.
 */
export function runHarnessPromise<A>(
  message: string,
  operation: () => PromiseLike<A>,
): Effect.Effect<A, HarnessFixtureError> {
  return Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new HarnessFixtureError({ message, cause }),
  });
}

/**
 * Retries an assertion until it holds.
 * @param assertion Assertion to poll.
 * @param message Label attached to a timeout.
 * @returns An Effect that succeeds once the assertion holds.
 * @failure HarnessFixtureError when the assertion never holds.
 */
export function waitForHarnessExpectation(
  assertion: () => void,
  message: string,
) {
  return runHarnessPromise(message, () => vi.waitFor(assertion));
}

/**
 * Creates the caller-owned client the plugin drains.
 *
 * `close` is not part of `HarnessClientService`; it is here so a test can
 * prove the plugin never closes a client it did not acquire.
 * @returns The injected client plus the handles a test drives it with.
 */
export function createHarnessFixture() {
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
  const client: InjectedHarnessClient = {
    agentId: SELF_AGENT_ID,
    startConversation,
    turns: Stream.fromQueue(turns),
    close: callerClose,
  };
  return { callerClose, client, reply, startConversation, turns };
}

/** Fixture handle a suite drives one injected client through. */
export type HarnessFixture = ReturnType<typeof createHarnessFixture>;

function makeHarnessTurn(
  reply: TurnReply,
  overrides: Partial<Omit<HarnessTurn, "reply">>,
): HarnessTurn {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    sender: { id: SENDER_AGENT_ID, name: SENDER_AGENT_NAME },
    text: INBOUND_TEXT,
    isFromMe: false,
    createdAt: CREATED_AT,
    conversationMeta: {
      type: "dm",
      participants: [`agent:${SELF_AGENT_ID}`, `agent:${SENDER_AGENT_ID}`],
    },
    contextBlocks: {},
    ...overrides,
    reply,
  };
}

/**
 * Offers one turn onto the injected client's stream.
 * @param fixture Fixture owning the turn stream.
 * @param overrides Turn fields that differ from the default DM turn.
 * @returns An Effect that completes once the turn is queued.
 */
export function offerHarnessTurn(
  fixture: HarnessFixture,
  overrides: Partial<Omit<HarnessTurn, "reply">> = {},
) {
  return Queue.offer(fixture.turns, makeHarnessTurn(fixture.reply, overrides));
}

/**
 * Starts one account on an already-built plugin.
 *
 * Two starts of the same plugin model an account restart, so this stays
 * separate from {@link startHarnessGateway}.
 * @param plugin Plugin under test.
 * @param overrides Optional logger and channel-runtime selection.
 * @returns The started gateway handle.
 */
export function startPluginHarnessGateway(
  plugin: MoltzapChannelPlugin,
  overrides: HarnessGatewayOverrides = {},
): StartedHarnessGateway {
  const dispatch = vi.fn().mockResolvedValue({ queuedFinal: true });
  const setStatus = vi.fn<(next: Record<string, unknown>) => void>();
  const abortController = new AbortController();
  const startFiber = Effect.runFork(
    runHarnessPromise("start Harness gateway", () =>
      plugin.gateway.startAccount({
        cfg: makeConfig(),
        accountId: ACCOUNT_ID,
        account: makeAccount(),
        abortSignal: abortController.signal,
        setStatus,
        ...(overrides.log === undefined ? {} : { log: overrides.log }),
        ...(overrides.withoutChannelRuntime === true
          ? {}
          : {
              channelRuntime: {
                reply: { dispatchReplyWithBufferedBlockDispatcher: dispatch },
              },
            }),
      }),
    ),
  );
  return { abortController, dispatch, plugin, setStatus, startFiber };
}

/**
 * Builds a plugin bound to one injected client and starts its account.
 * @param fixture Fixture whose client the plugin receives.
 * @param overrides Optional logger and channel-runtime selection.
 * @returns The started gateway handle plus the injection spy.
 */
export function startHarnessGateway(
  fixture: HarnessFixture,
  overrides: HarnessGatewayOverrides = {},
): StartedInjectedHarnessGateway {
  const harnessClientForAccount = vi.fn(() => fixture.client);
  const plugin: MoltzapChannelPlugin = createMoltzapChannelPlugin({
    harnessClientForAccount,
  });
  return {
    ...startPluginHarnessGateway(plugin, overrides),
    harnessClientForAccount,
  };
}

/**
 * Waits until the gateway publishes its connected status.
 * @param started Started gateway handle.
 * @param started.setStatus OpenClaw's status callback spy.
 * @returns An Effect that completes once the status is published.
 * @failure HarnessFixtureError when the status never arrives.
 */
export function waitForGatewayStart(started: {
  readonly setStatus: SetStatus;
}) {
  return waitForHarnessExpectation(() => {
    expect(started.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID, connected: true }),
    );
  }, "wait for Harness gateway start");
}

/**
 * Waits until OpenClaw's reply dispatcher has been called `count` times.
 * @param dispatch Reply dispatcher spy.
 * @param count Expected call count.
 * @returns An Effect that completes once the count is reached.
 * @failure HarnessFixtureError when the count is never reached.
 */
export function waitForDispatchTimes(dispatch: Dispatch, count: number) {
  return waitForHarnessExpectation(() => {
    expect(dispatch).toHaveBeenCalledTimes(count);
  }, `wait for ${count} dispatch calls`);
}

/**
 * Reads the first reply-dispatch call.
 * @param dispatch Reply dispatcher spy.
 * @returns The first dispatch argument.
 */
export function firstDispatchCall(dispatch: Dispatch): HarnessDispatchCall {
  return /* Safe because callers wait until dispatch has one call. */ dispatch
    .mock.calls[0]?.[0] as HarnessDispatchCall;
}

/**
 * Sends outbound text through the plugin's OpenClaw surface.
 * @param plugin Plugin under test.
 * @param to OpenClaw target.
 * @param text Message body.
 * @param accountId Account the send is attributed to.
 * @returns An Effect carrying OpenClaw's send result.
 * @failure HarnessFixtureError when the boundary call rejects.
 */
export function sendHarnessText(
  plugin: MoltzapChannelPlugin,
  to: string,
  text: string,
  accountId: string = ACCOUNT_ID,
): Effect.Effect<SendTextResult, HarnessFixtureError> {
  return runHarnessPromise("send Harness text", () =>
    plugin.outbound.sendText({ cfg: makeConfig(), accountId, to, text }),
  );
}

/**
 * Stops the account through the plugin's OpenClaw surface.
 * @param plugin Plugin under test.
 * @returns An Effect that completes once the stop returns.
 * @failure HarnessFixtureError when the boundary call rejects.
 */
export function stopHarnessAccount(plugin: MoltzapChannelPlugin) {
  return runHarnessPromise("stop Harness account", () =>
    plugin.gateway.stopAccount({ accountId: ACCOUNT_ID }),
  );
}

/**
 * Releases a started gateway whether or not the example stopped it.
 * @param started Started gateway handle.
 * @returns An Effect that completes once the start fiber is gone.
 */
export function cleanUpStart(started: StartedHarnessGateway) {
  return Effect.sync(() => {
    started.abortController.abort();
  }).pipe(Effect.zipRight(Fiber.interrupt(started.startFiber)), Effect.asVoid);
}
