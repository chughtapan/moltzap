/**
 * @file The `MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES` experiment switch: what
 * the message tool offers and which sends it refuses.
 */

import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { Data, Effect, FastCheck as fc } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMoltzapChannelPlugin } from "./plugin.js";

const HIDE_COLLECTIVES = "MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES";
const REFUSAL = "collective operations are not available";
const CONFIG: OpenClawConfig = {
  channels: { moltzap: { accounts: [{ id: "primary" }] } },
};

class SwitchTestError extends Data.TaggedError("SwitchTestError")<{
  readonly detail: string;
}> {}

describe("OpenClaw hide-collectives experiment switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "offers reply and the collective parameters when the switch is absent",
    switchAbsentOffersParameters,
  );
  it(
    "offers send alone, without the collective parameters, when the switch is true",
    switchOnOmitsParameters,
  );
  it(
    "passes a send without collective parameters on to the account when the switch is true",
    switchOnPassesPlainSend,
  );
  it(
    "refuses every send carrying a collective value when the switch is true",
    switchOnRefusesCollective,
  );
  it(
    "refuses every reply carrying a collectiveResponse value when the switch is true",
    switchOnRefusesCollectiveResponse,
  );
  it(
    "fails a collective send naming the switch when its value is not a boolean",
    invalidSwitchFailsCollectiveSend,
  );
});

function switchAbsentOffersParameters() {
  vi.stubEnv(HIDE_COLLECTIVES, undefined);

  expect(offeredParameters()).toEqual({
    send: ["collective"],
    reply: ["collectiveResponse"],
  });
}

function switchOnOmitsParameters() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  const discovery = createMoltzapChannelPlugin().actions?.describeMessageTool({
    cfg: CONFIG,
  });

  expect(discovery).toEqual({ actions: ["send"] });
}

/** No account is connected, so a send the switch admits fails as not connected. */
function switchOnPassesPlainSend() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  return Effect.runPromise(
    sendAction({ to: "agent:nova", message: "hello" }).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The closed failure reason shows the send reached the account.
        expect(failure.detail).toContain("account-not-connected");
      }),
    ),
  );
}

function switchOnRefusesCollective() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  return fc.assert(
    fc.asyncProperty(fc.jsonValue(), (value) =>
      refused("send", {
        to: "agent:nova",
        message: "Which day?",
        collective: value,
      }),
    ),
  );
}

function switchOnRefusesCollectiveResponse() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  return fc.assert(
    fc.asyncProperty(fc.jsonValue(), (value) =>
      refused("reply", { collectiveResponse: value }),
    ),
  );
}

function invalidSwitchFailsCollectiveSend() {
  vi.stubEnv(HIDE_COLLECTIVES, "sometimes");

  return Effect.runPromise(
    sendAction({
      to: "agent:nova",
      message: "Which day?",
      collective: { op: "multicast" },
    }).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        expect(failure.detail).toContain(HIDE_COLLECTIVES);
      }),
    ),
  );
}

/**
 * Names the parameters each message tool schema contribution adds, keyed by
 * the actions it applies to.
 */
function offeredParameters(): Readonly<Record<string, readonly string[]>> {
  const discovery = createMoltzapChannelPlugin().actions?.describeMessageTool({
    cfg: CONFIG,
  });
  expect(discovery?.actions).toEqual(["send", "reply"]);
  const schema = discovery?.schema ?? [];
  const contributions = Array.isArray(schema) ? schema : [schema];
  return Object.fromEntries(
    contributions.map(({ actions, properties }) => [
      (actions ?? []).join(","),
      Object.keys(properties),
    ]),
  );
}

/**
 * Runs one action and resolves true once it fails with the refusal, the form
 * `fc.asyncProperty` counts as a pass.
 */
function refused(
  action: "send" | "reply",
  params: ChannelMessageActionContext["params"],
) {
  return Effect.runPromise(
    messageAction(action, params).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        expect(failure.detail).toContain(REFUSAL);
      }),
      Effect.as(true),
    ),
  );
}

function sendAction(params: ChannelMessageActionContext["params"]) {
  return messageAction("send", params);
}

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
