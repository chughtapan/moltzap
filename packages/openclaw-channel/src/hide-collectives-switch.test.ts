/**
 * @file The `MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES` experiment switch: which
 * message texts it refuses.
 */

import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { Data, Effect, FastCheck as fc } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMoltzapChannelPlugin } from "./plugin.js";

const HIDE_COLLECTIVES = "MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES";
const REFUSAL = "gather, all_gather and answers are not available";
const CONFIG: OpenClawConfig = {
  channels: { moltzap: { accounts: [{ id: "primary" }] } },
};
const SLOT_SCHEMA = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
};

/** Texts that state an operation, one of them invalidly. */
const OPERATION_TEXTS = [
  { gather: "Which day?", deadline: 60, requestedSchema: SLOT_SCHEMA },
  { all_gather: "Which day?", deadline: 60, requestedSchema: SLOT_SCHEMA },
  { action: "accept", content: { slot: "mon" } },
  { action: "decline" },
  { action: "cancel" },
  { gather: "Which day?", deadline: 0 },
].map((value) => JSON.stringify(value));

class SwitchTestError extends Data.TaggedError("SwitchTestError")<{
  readonly detail: string;
}> {}

describe("OpenClaw hide-collectives experiment switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "offers the same send and reply actions whether or not the switch is set",
    switchLeavesActionsUnchanged,
  );
  it(
    "passes plain text on to the account when the switch is true",
    switchOnPassesPlainText,
  );
  it(
    "passes JSON text without an operation key on to the account when the switch is true",
    switchOnPassesJsonProse,
  );
  it(
    "refuses every operation text on send and reply when the switch is true",
    switchOnRefusesOperationText,
  );
  it(
    "fails an operation text naming the switch when its value is not a boolean",
    invalidSwitchFailsOperationText,
  );
});

function switchLeavesActionsUnchanged() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");
  const hidden = describeTool();
  vi.stubEnv(HIDE_COLLECTIVES, undefined);

  expect(hidden).toEqual({ actions: ["send", "reply"] });
  expect(describeTool()).toEqual(hidden);
}

function describeTool() {
  return createMoltzapChannelPlugin().actions?.describeMessageTool({
    cfg: CONFIG,
  });
}

/** No account is connected, so a send the switch admits fails as not connected. */
function switchOnPassesPlainText() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  return reachesAccount("hello");
}

function switchOnPassesJsonProse() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  return reachesAccount('{"note": "mon or tue"}');
}

function reachesAccount(message: string) {
  return Effect.runPromise(
    messageAction("send", { to: "agent:nova", message }).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The closed failure reason shows the send reached the account.
        expect(failure.detail).toContain("account-not-connected");
      }),
    ),
  );
}

function switchOnRefusesOperationText() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  return fc.assert(
    fc.asyncProperty(
      fc.constantFrom("send" as const, "reply" as const),
      fc.constantFrom(...OPERATION_TEXTS),
      (action, message) =>
        Effect.runPromise(
          messageAction(action, { to: "agent:nova", message }).pipe(
            Effect.flip,
            Effect.tap((failure) => {
              expect(failure.detail).toContain(REFUSAL);
            }),
            Effect.as(true),
          ),
        ),
    ),
  );
}

function invalidSwitchFailsOperationText() {
  vi.stubEnv(HIDE_COLLECTIVES, "sometimes");

  return Effect.runPromise(
    messageAction("send", {
      to: "agent:nova",
      message: '{"action":"decline"}',
    }).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        expect(failure.detail).toContain(HIDE_COLLECTIVES);
      }),
    ),
  );
}

/**
 * The plugin checks the switch before it looks up the account, so a refusal
 * needs no connected account.
 */
function messageAction(
  action: "send" | "reply",
  params: ChannelMessageActionContext["params"],
) {
  const handleAction = createMoltzapChannelPlugin().actions?.handleAction;
  return Effect.tryPromise({
    try: () =>
      handleAction?.({
        channel: "moltzap",
        action,
        cfg: CONFIG,
        accountId: "primary",
        params,
      }) ?? Promise.reject(new Error("missing action handler")),
    catch: (cause) => new SwitchTestError({ detail: String(cause) }),
  });
}
