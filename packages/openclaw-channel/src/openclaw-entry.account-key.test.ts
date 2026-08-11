import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect, vi } from "vitest";
import {
  createMoltzapChannelPlugin,
  type OpenClawStartAccountContext,
} from "./openclaw-entry.js";
import {
  cleanUpStart,
  createHarnessFixture,
  firstDispatchCall,
  makeAccount,
  makeConfig,
  offerHarnessTurn,
  runHarnessPromise,
  sendHarnessText,
  waitForDispatchTimes,
  waitForHarnessExpectation,
} from "./test-utils/harness-fixture.js";

const ACCOUNT_ID = "canonical-account";
const PADDED_ACCOUNT_ID = ` \t${ACCOUNT_ID}\n`;
const ALTERNATE_PADDED_ACCOUNT_ID = `\n${ACCOUNT_ID} `;
const TARGET = "agent:recipient";
const TEXT = "hello";

// @agent-code-guard/regression-only: this example separates OpenClaw's host account id from the canonical internal lifecycle key.
describe("OpenClaw account key", () => {
  it(
    "preserves the host id while canonicalizing acquisition, outbound, and stop",
    separatesHostAndInternalAccountKeys,
  );
});

function startPaddedGateway() {
  const fixture = createHarnessFixture();
  const harnessClientForAccount = vi.fn(() => fixture.client);
  const plugin = createMoltzapChannelPlugin({ harnessClientForAccount });
  const abortController = new AbortController();
  const dispatch = vi.fn().mockResolvedValue({ queuedFinal: true });
  const setStatus = vi.fn<OpenClawStartAccountContext["setStatus"]>();
  const startFiber = Effect.runFork(
    runHarnessPromise("start padded account", () =>
      plugin.gateway.startAccount({
        cfg: makeConfig(PADDED_ACCOUNT_ID),
        accountId: PADDED_ACCOUNT_ID,
        account: makeAccount(PADDED_ACCOUNT_ID),
        abortSignal: abortController.signal,
        setStatus,
        channelRuntime: {
          reply: { dispatchReplyWithBufferedBlockDispatcher: dispatch },
        },
      }),
    ),
  );
  return {
    abortController,
    dispatch,
    fixture,
    harnessClientForAccount,
    plugin,
    setStatus,
    startFiber,
  };
}

function separatesHostAndInternalAccountKeys() {
  const started = startPaddedGateway();
  return Effect.gen(function* () {
    yield* waitForHarnessExpectation(() => {
      expect(started.harnessClientForAccount).toHaveBeenCalledExactlyOnceWith(
        ACCOUNT_ID,
        makeAccount(PADDED_ACCOUNT_ID),
      );
      expect(started.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: PADDED_ACCOUNT_ID,
          connected: true,
        }),
      );
    }, "wait for split account-key startup");

    yield* offerHarnessTurn(started.fixture);
    yield* waitForDispatchTimes(started.dispatch, 1);
    expect(firstDispatchCall(started.dispatch).ctx.AccountId).toBe(
      PADDED_ACCOUNT_ID,
    );

    const beforeStop = yield* sendHarnessText(
      started.plugin,
      TARGET,
      TEXT,
      PADDED_ACCOUNT_ID,
    );
    expect(beforeStop.ok).toBe(true);

    yield* runHarnessPromise("stop padded account", () =>
      started.plugin.gateway.stopAccount({
        accountId: ALTERNATE_PADDED_ACCOUNT_ID,
      }),
    );
    const afterStop = yield* sendHarnessText(
      started.plugin,
      TARGET,
      TEXT,
      ACCOUNT_ID,
    );
    expect(afterStop.ok).toBe(false);
  }).pipe(Effect.ensuring(cleanUpStart(started)));
}
