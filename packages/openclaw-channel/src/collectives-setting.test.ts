/**
 * @file The `channels.moltzap.collectives` setting: what the message tool
 * offers and which sends it refuses when collectives are on or off.
 */

import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { Data, Effect, FastCheck as fc } from "effect";
import { describe, expect, it } from "vitest";

import { createMoltzapChannelPlugin } from "./plugin.js";

const REFUSAL = "collective operations are not available";

class SettingTestError extends Data.TaggedError("SettingTestError")<{
  readonly detail: string;
}> {}

describe("OpenClaw channel collectives setting", () => {
  it.each([
    { setting: "true", cfg: configWithCollectives(true) },
    { setting: "unset", cfg: configWithCollectives() },
  ])(
    "offers the collective parameters when collectives is $setting",
    ({ cfg }) => {
      expect(offeredParameters(cfg)).toEqual([
        "collective",
        "collectiveResponse",
      ]);
    },
  );
  it(
    "offers send without the collective parameters when collectives is false",
    collectivesOffOmitsParameters,
  );
  it(
    "passes a send without collective parameters on to the account when collectives is false",
    collectivesOffPassesPlainSend,
  );
  it(
    "refuses every send carrying a collective or collectiveResponse value when collectives is false",
    collectivesOffRefusesCollectiveParameters,
  );
});

function collectivesOffOmitsParameters() {
  const discovery = createMoltzapChannelPlugin().actions?.describeMessageTool({
    cfg: configWithCollectives(false),
  });

  expect(discovery).toEqual({ actions: ["send"] });
}

/** No account is connected, so a send the setting admits fails as not connected. */
function collectivesOffPassesPlainSend() {
  return Effect.runPromise(
    sendWithCollectivesOff({ to: "agent:nova", message: "hello" }).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The closed failure reason shows the send reached the account.
        expect(failure.detail).toContain("account-not-connected");
      }),
    ),
  );
}

function collectivesOffRefusesCollectiveParameters() {
  return fc.assert(
    fc.asyncProperty(
      fc.constantFrom("collective", "collectiveResponse"),
      fc.jsonValue(),
      (parameter, value) =>
        refusedWithCollectivesOff({
          to: "agent:nova",
          message: "Which day?",
          [parameter]: value,
        }),
    ),
  );
}

/**
 * Names the parameters the message tool's schema contribution adds, or none
 * when the discovery carries no single contribution.
 */
function offeredParameters(cfg: OpenClawConfig): readonly string[] {
  const schema = createMoltzapChannelPlugin().actions?.describeMessageTool({
    cfg,
  })?.schema;
  return schema === undefined || schema === null || Array.isArray(schema)
    ? []
    : Object.keys(schema.properties);
}

/**
 * Runs one send with collectives off and resolves true once it fails with the
 * refusal, the form `fc.asyncProperty` counts as a pass.
 */
function refusedWithCollectivesOff(
  params: ChannelMessageActionContext["params"],
) {
  return Effect.runPromise(
    sendWithCollectivesOff(params).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        expect(failure.detail).toContain(REFUSAL);
      }),
      Effect.as(true),
    ),
  );
}

function sendWithCollectivesOff(params: ChannelMessageActionContext["params"]) {
  const handleAction = createMoltzapChannelPlugin().actions?.handleAction;
  return Effect.tryPromise({
    try: () =>
      handleAction?.({
        channel: "moltzap",
        action: "send",
        cfg: configWithCollectives(false),
        accountId: "primary",
        params,
      }) ?? Promise.reject(new Error("missing action handler")),
    catch: (cause) => new SettingTestError({ detail: String(cause) }),
  });
}

function configWithCollectives(collectives?: boolean): OpenClawConfig {
  return {
    channels: {
      moltzap: {
        accounts: [{ id: "primary" }],
        ...(collectives === undefined ? {} : { collectives }),
      },
    },
  };
}
