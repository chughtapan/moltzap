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
const BOB = "bob";
const EVALUATION_PEER = "evaluation-peer";
const AGENT_MULTI_WORD = "agent:multi-word-name";
const PLAIN_ID = "plain-id";
const EMPTY_TARGET = "";
const UNKNOWN_USER_PREFIX = "user:someone";
const HTTP_TARGET = "http://example.com";
const EMPTY_AGENT = "agent:";
const INVALID_AGENT_NAME = "not a valid agent name";
const EMPTY_CONVERSATION = "conv:";
const CONVERSATION_ABC = "conv:abc-123";
const CONVERSATION_ABC_DISPLAY = "abc-123";
const UNKNOWN_PREFIX_TARGET = "unknown:foo";
const SPACED_AGENT_BOB = "  agent:bob  ";
const BOB_DISPLAY = "bob";
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

function resolvesPlainAgentName() {
  return Effect.gen(function* () {
    const result = yield* tryResolveMessagingTarget(
      EVALUATION_PEER,
      EVALUATION_PEER,
    );
    expect(result).toEqual({
      to: `agent:${EVALUATION_PEER}`,
      kind: USER_KIND,
      display: EVALUATION_PEER,
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

function returnsNullForUnrecognizedFormats() {
  return Effect.gen(function* () {
    const result = yield* tryResolveMessagingTarget(
      INVALID_AGENT_NAME,
      INVALID_AGENT_NAME,
    );
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
    expect(looksLikeId(EMPTY_CONVERSATION)).toBe(false);
  });
});

describe("messaging.targetResolver.resolveTarget", () => {
  it("resolves agent targets as user targets", resolvesAgentTarget);
  it("normalizes plain agent names as user targets", resolvesPlainAgentName);
  it(
    "resolves conversation targets as group targets",
    resolvesConversationTarget,
  );
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

  vitestIt("normalizes plain agent names", () => {
    expect(resolveOutboundTarget({ to: BOB })).toMatchObject({
      ok: true,
      to: AGENT_BOB,
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
