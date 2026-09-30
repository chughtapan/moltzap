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
    "offers the collective parameters when the switch is absent",
    switchAbsentOffersParameters,
  );
  it(
    "offers send without the collective parameters when the switch is true",
    switchOnOmitsParameters,
  );
  it(
    "passes a send without collective parameters on to the account when the switch is true",
    switchOnPassesPlainSend,
  );
  it(
    "refuses every send carrying a collective or collectiveResponse value when the switch is true",
    switchOnRefusesCollectiveParameters,
  );
  it(
    "fails a collective send naming the switch when its value is not a boolean",
    invalidSwitchFailsCollectiveSend,
  );
});

function switchAbsentOffersParameters() {
  vi.stubEnv(HIDE_COLLECTIVES, undefined);

  expect(offeredParameters()).toEqual(["collective", "collectiveResponse"]);
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

function switchOnRefusesCollectiveParameters() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  return fc.assert(
    fc.asyncProperty(
      fc.constantFrom("collective", "collectiveResponse"),
      fc.jsonValue(),
      (parameter, value) =>
        refusedSend({
          to: "agent:nova",
          message: "Which day?",
          [parameter]: value,
        }),
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
 * Names the parameters the message tool's schema contribution adds, or none
 * when the discovery carries no single contribution.
 */
function offeredParameters(): readonly string[] {
  const schema = createMoltzapChannelPlugin().actions?.describeMessageTool({
    cfg: CONFIG,
  })?.schema;
  return schema === undefined || schema === null || Array.isArray(schema)
    ? []
    : Object.keys(schema.properties);
}

/**
 * Runs one send and resolves true once it fails with the refusal, the form
 * `fc.asyncProperty` counts as a pass.
 */
function refusedSend(params: ChannelMessageActionContext["params"]) {
  return Effect.runPromise(
    sendAction(params).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        expect(failure.detail).toContain(REFUSAL);
      }),
      Effect.as(true),
    ),
  );
}

function sendAction(params: ChannelMessageActionContext["params"]) {
  const handleAction = createMoltzapChannelPlugin().actions?.handleAction;
  return Effect.tryPromise({
    try: () =>
      handleAction?.({
        channel: "moltzap",
        action: "send",
        cfg: CONFIG,
        accountId: "primary",
        params,
      }) ?? Promise.reject(new Error("missing action handler")),
    catch: (cause) => new SwitchTestError({ detail: String(cause) }),
  });
}
