import { describe, expect, it as vitestIt } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";

import { moltzapChannelPlugin } from "./openclaw-entry.js";

const looksLikeId =
  moltzapChannelPlugin.messaging.targetResolver.looksLikeId.bind(
    moltzapChannelPlugin.messaging.targetResolver,
  );
const resolveMessagingTarget =
  moltzapChannelPlugin.messaging.targetResolver.resolveTarget.bind(
    moltzapChannelPlugin.messaging.targetResolver,
  );
const resolveOutboundTarget = moltzapChannelPlugin.outbound.resolveTarget.bind(
  moltzapChannelPlugin.outbound,
);
const resolveAccount = moltzapChannelPlugin.config.resolveAccount.bind(
  moltzapChannelPlugin.config,
);
const isConfiguredAccount = moltzapChannelPlugin.config.isConfigured.bind(
  moltzapChannelPlugin.config,
);
const cfg: Parameters<typeof resolveMessagingTarget>[0]["cfg"] = {};

const AGENT_BOB = "agent:bob";
const AGENT_MULTI_WORD = "agent:multi-word-name";
const TASK_ABC = "task:t1:abc-123";
const TASK_UUID =
  "task:e12fe562-ed1f-4d2d-bed5-68b8edfa41cb:a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PLAIN_ID = "plain-id";
const EMPTY_TARGET = "";
const UNKNOWN_USER_PREFIX = "user:someone";
const HTTP_TARGET = "http://example.com";
const EMPTY_AGENT = "agent:";
const EMPTY_TASK = "task:";
const EMPTY_CONVERSATION = "conv:";
const UNKNOWN_TEXT = "unknown";
const OUTBOUND_TASK = "task:t1:abc";
const PLAIN_CONV_ID = "plain-conv-id";
const CONVERSATION_ABC = "conv:abc-123";
const CONVERSATION_ABC_DISPLAY = "abc-123";
const UNKNOWN_PREFIX_TARGET = "unknown:foo";
const SPACED_AGENT_BOB = "  agent:bob  ";
const BOB_DISPLAY = "bob";
const TASK_ABC_DISPLAY = "t1:abc-123";
const USER_KIND = "user";
const GROUP_KIND = "group";
const NORMALIZED_SOURCE = "normalized";
const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const UNKNOWN_ACCOUNT = "unknown-account";

const accountCfg = {
  channels: {
    moltzap: {
      accounts: [
        { id: ACCOUNT_A, agentName: "agent-a" },
        { id: ACCOUNT_B, agentName: "agent-b" },
      ],
    },
  },
};

function tryResolveMessagingTarget(input: string, normalized: string) {
  return Effect.tryPromise({
    try: () => resolveMessagingTarget({ cfg, input, normalized }),
    catch: (cause) => cause,
  });
}

function resolvesAgentTarget() {
  return Effect.gen(function* () {
    const result = yield* tryResolveMessagingTarget(AGENT_BOB, AGENT_BOB);
    expect(result).toEqual({
      to: AGENT_BOB,
      kind: USER_KIND,
      display: BOB_DISPLAY,
      source: NORMALIZED_SOURCE,
    });
  });
}

function resolvesConversationTarget() {
  return Effect.gen(function* () {
    const result = yield* tryResolveMessagingTarget(
      CONVERSATION_ABC,
      CONVERSATION_ABC,
    );
    expect(result).toEqual({
      to: CONVERSATION_ABC,
      kind: GROUP_KIND,
      display: CONVERSATION_ABC_DISPLAY,
      source: NORMALIZED_SOURCE,
    });
  });
}

function resolvesTaskTarget() {
  return Effect.gen(function* () {
    const result = yield* tryResolveMessagingTarget(TASK_ABC, TASK_ABC);
    expect(result).toEqual({
      to: TASK_ABC,
      kind: GROUP_KIND,
      display: TASK_ABC_DISPLAY,
      source: NORMALIZED_SOURCE,
    });
  });
}

function returnsNullForUnrecognizedFormats() {
  return Effect.gen(function* () {
    const result = yield* tryResolveMessagingTarget(UNKNOWN_TEXT, UNKNOWN_TEXT);
    expect(result).toBeNull();
  });
}

describe("isMoltZapTarget accepted ids", () => {
  vitestIt("recognizes agent targets", () => {
    expect(looksLikeId(AGENT_BOB)).toBe(true);
    expect(looksLikeId(AGENT_MULTI_WORD)).toBe(true);
  });

  vitestIt("recognizes conversation targets", () => {
    expect(looksLikeId(CONVERSATION_ABC)).toBe(true);
  });

  vitestIt("recognizes task targets", () => {
    expect(looksLikeId(TASK_ABC)).toBe(true);
    expect(looksLikeId(TASK_UUID)).toBe(true);
  });
});

describe("isMoltZapTarget rejected ids", () => {
  vitestIt("rejects plain strings", () => {
    expect(looksLikeId(PLAIN_ID)).toBe(false);
    expect(looksLikeId(EMPTY_TARGET)).toBe(false);
  });

  vitestIt("rejects unknown prefixes", () => {
    expect(looksLikeId(UNKNOWN_USER_PREFIX)).toBe(false);
    expect(looksLikeId(HTTP_TARGET)).toBe(false);
  });

  vitestIt("rejects empty identifier after prefix", () => {
    expect(looksLikeId(EMPTY_AGENT)).toBe(false);
    expect(looksLikeId(EMPTY_TASK)).toBe(false);
    expect(looksLikeId(EMPTY_CONVERSATION)).toBe(false);
  });
});

describe("messaging.targetResolver.resolveTarget", () => {
  it("resolves agent targets as user targets", resolvesAgentTarget);
  it(
    "resolves conversation targets as group targets",
    resolvesConversationTarget,
  );
  it("resolves task targets as group targets", resolvesTaskTarget);
  it(
    "returns null for unrecognized formats",
    returnsNullForUnrecognizedFormats,
  );
});

describe("outbound.resolveTarget accepted targets", () => {
  vitestIt("accepts agent targets", () => {
    expect(resolveOutboundTarget({ to: AGENT_BOB })).toMatchObject({
      ok: true,
      to: AGENT_BOB,
    });
  });

  vitestIt("accepts conversation targets", () => {
    expect(resolveOutboundTarget({ to: CONVERSATION_ABC })).toMatchObject({
      ok: true,
      to: CONVERSATION_ABC,
    });
  });

  vitestIt("accepts task targets", () => {
    expect(resolveOutboundTarget({ to: OUTBOUND_TASK })).toMatchObject({
      ok: true,
      to: OUTBOUND_TASK,
    });
  });

  vitestIt("accepts plain conversation IDs", () => {
    expect(resolveOutboundTarget({ to: PLAIN_CONV_ID })).toMatchObject({
      ok: true,
      to: PLAIN_CONV_ID,
    });
  });
});

describe("outbound.resolveTarget rejected targets", () => {
  vitestIt("rejects empty target", () => {
    expect(resolveOutboundTarget({ to: EMPTY_TARGET }).ok).toBe(false);
  });

  vitestIt("rejects undefined target", () => {
    expect(resolveOutboundTarget({}).ok).toBe(false);
  });

  vitestIt("rejects unknown prefix", () => {
    expect(resolveOutboundTarget({ to: UNKNOWN_PREFIX_TARGET }).ok).toBe(false);
  });
});

describe("outbound.resolveTarget normalization", () => {
  vitestIt("trims whitespace", () => {
    expect(resolveOutboundTarget({ to: SPACED_AGENT_BOB })).toMatchObject({
      ok: true,
      to: AGENT_BOB,
    });
  });
});

describe("config.resolveAccount", () => {
  vitestIt("resolves the exact configured account id", () => {
    expect(resolveAccount(accountCfg, ACCOUNT_B)).toEqual({
      id: ACCOUNT_B,
      agentName: "agent-b",
    });
  });

  vitestIt(
    "does not fall back to the first account when account id is omitted",
    () => {
      const account = resolveAccount(accountCfg);
      expect(account).toEqual({ id: "", enabled: false });
      expect(isConfiguredAccount(account)).toBe(false);
    },
  );

  vitestIt(
    "does not create enabled placeholder accounts for unknown ids",
    () => {
      const account = resolveAccount(accountCfg, UNKNOWN_ACCOUNT);
      expect(account).toEqual({ id: UNKNOWN_ACCOUNT, enabled: false });
      expect(isConfiguredAccount(account)).toBe(false);
    },
  );
});
