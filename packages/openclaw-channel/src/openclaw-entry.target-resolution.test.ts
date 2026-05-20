import { describe, expect, it as vitestIt } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";

import { moltzapChannelPlugin } from "./openclaw-entry.js";

const looksLikeId = moltzapChannelPlugin.messaging.targetResolver.looksLikeId;
const resolveMessagingTarget =
  moltzapChannelPlugin.messaging.targetResolver.resolveTarget;
const resolveOutboundTarget = moltzapChannelPlugin.outbound.resolveTarget;
const cfg = {} as Parameters<typeof resolveMessagingTarget>[0]["cfg"];

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
const UNKNOWN_TEXT = "unknown";
const OUTBOUND_TASK = "task:t1:abc";
const PLAIN_CONV_ID = "plain-conv-id";
const UNKNOWN_PREFIX_TARGET = "unknown:foo";
const SPACED_AGENT_BOB = "  agent:bob  ";
const BOB_DISPLAY = "bob";
const TASK_ABC_DISPLAY = "t1:abc-123";
const USER_KIND = "user";
const GROUP_KIND = "group";
const NORMALIZED_SOURCE = "normalized";

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
  });
});

describe("messaging.targetResolver.resolveTarget", () => {
  it("resolves agent targets as user targets", resolvesAgentTarget);
  it("resolves task targets as group targets", resolvesConversationTarget);
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
