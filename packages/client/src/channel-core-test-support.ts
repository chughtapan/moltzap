/**
 * @file Shared fixtures, branded identifiers, and assertions for channel-core
 * tests.
 */

import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import { it as effectIt } from "@effect/vitest";
import { Data, Effect } from "effect";

import type { CrossConversationEntry } from "./service.js";
import {
  type ChannelService,
  type EnrichedInboundMessage,
  type InboundInterceptDecision,
  MoltZapChannelCore,
} from "./channel-core.js";
import {
  buildMessage,
  createFakeChannelService,
  type FakeChannelService,
  flushDispatchChainEffect,
  testAgentId,
  testConversationId,
  testMessageId,
} from "./test-utils/index.js";

/** Re-exports the public API from `current module`. */
export {
  buildMessage,
  createFakeChannelService,
  flushDispatchChainEffect,
  MoltZapChannelCore,
};
/** Re-exports the public API from `current module`. */
export type {
  CrossConversationEntry,
  EnrichedInboundMessage,
  FakeChannelService,
  InboundInterceptDecision,
  Message,
};

/** Effect-aware Vitest helper for test cases that do not allocate a scope. */
export const effectTest = effectIt.effect;
/** Cached name that distinguishes synchronous sender lookup in assertions. */
export const ALICE_CACHED_NAME = "Alice (cached)";
/** Resolved name that distinguishes fallback sender lookup in assertions. */
export const ALICE_RESOLVED_NAME = "Alice (via resolve)";
/** Two-line payload used to pin joining of adjacent text parts. */
export const MULTILINE_TEXT = "line one\nline two";
/** Caption on a non-text fixture part that enrichment must omit. */
export const CAPTION_TEXT = "caption";
/** Primary payload used by single-message and coalescing tests. */
export const FIRST_TEXT = "first";
/** Follow-up payload used by coalescing and ordering tests. */
export const SECOND_TEXT = "second";
/** Stable display name for group-conversation metadata assertions. */
export const DEVS_GROUP_NAME = "devs";
/** Context payload whose one-time visibility pins marker commits. */
export const FIRST_VISIT_TEXT = "first visit";

/** Reports test inbound handler failures. */
export class TestInboundHandlerError extends Data.TaggedError(
  "TestInboundHandlerError",
)<{
  readonly message: string;
}> {}

/** Decodes a short fixture label as a branded agent identifier. */
export const agent: (agentLabel: string) => AgentId = testAgentId;
/** Decodes a short fixture label as a branded conversation identifier. */
export const conversation: (conversationLabel: string) => ConversationId =
  testConversationId;
/** Decodes a short fixture label as a branded message identifier. */
export const message: (messageLabel: string) => MessageId = testMessageId;
/**
 * Formats a fixture agent using the service's stored participant-key shape.
 * @param agentLabel Short fixture identifier to brand and prefix.
 * @returns The participant key used by conversation metadata fixtures.
 */
export const participant = (agentLabel: string): string =>
  "agent:" + agent(agentLabel);

/** Connected fake service, core, and sink used by enrichment-focused tests. */
export interface ChannelCoreFixture {
  readonly fake: FakeChannelService;
  readonly service: ChannelService;
  readonly core: MoltZapChannelCore;
  readonly inbound: EnrichedInboundMessage[];
}

/**
 * Creates a core whose enriched handler appends every delivered turn.
 * @returns The fake service controls and accumulated inbound messages.
 */
export function createChannelCoreFixture(): ChannelCoreFixture {
  const fake = createFakeChannelService({ ownAgentId: "agent-self" });
  const inbound: EnrichedInboundMessage[] = [];
  const core = new MoltZapChannelCore({ service: fake.service });
  core.onInbound((msg) =>
    Effect.sync(() => {
      inbound.push(msg);
    }),
  );
  return { fake, service: fake.service, core, inbound };
}

/**
 * Creates the compact fixture used by tests that need only a fake and sink.
 * @returns The fake service, core, and accumulated delivered messages.
 */
export function customSetup(): {
  fake: FakeChannelService;
  core: MoltZapChannelCore;
  received: EnrichedInboundMessage[];
} {
  const fake = createFakeChannelService({ ownAgentId: "agent-self" });
  const received: EnrichedInboundMessage[] = [];
  const core = new MoltZapChannelCore({ service: fake.service });
  core.onInbound((m) =>
    Effect.sync(() => {
      received.push(m);
    }),
  );
  return { fake, core, received };
}

/**
 * Bypasses the fake's name cache so enrichment exercises deferred resolution.
 * @param fake Service fixture whose cache lookup should always miss.
 */
export function forceResolveAgentNamePath(fake: FakeChannelService): void {
  /* Safe because the surrounding invariant establishes this asserted shape. */
  (
    fake.service as { getAgentName: (id: string) => string | undefined }
  ).getAgentName = () => undefined;
}
