import { it as effectIt } from "@effect/vitest";
import type { Message } from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import { Data, Effect } from "effect";

import {
  MoltZapChannelCore,
  type ChannelService,
  type EnrichedInboundMessage,
  type InboundInterceptDecision,
} from "./channel-core.js";
import type { CrossConversationEntry } from "./service.js";
import {
  buildMessage,
  createFakeChannelService,
  flushDispatchChainEffect,
  testAgentId,
  testConversationId,
  testMessageId,
  type FakeChannelService,
} from "./test-utils/index.js";

/** Re-exports the public API from `current module`. */
export {
  MoltZapChannelCore,
  buildMessage,
  createFakeChannelService,
  flushDispatchChainEffect,
};
/** Re-exports the public API from `current module`. */
export type {
  CrossConversationEntry,
  EnrichedInboundMessage,
  FakeChannelService,
  InboundInterceptDecision,
  Message,
};

/** Provides the effect test runtime value. */
export const effectTest = effectIt.effect;
/** Provides the alice cached name runtime value. */
export const ALICE_CACHED_NAME = "Alice (cached)";
/** Provides the alice resolved name runtime value. */
export const ALICE_RESOLVED_NAME = "Alice (via resolve)";
/** Provides the multiline text runtime value. */
export const MULTILINE_TEXT = "line one\nline two";
/** Provides the caption text runtime value. */
export const CAPTION_TEXT = "caption";
/** Provides the first text runtime value. */
export const FIRST_TEXT = "first";
/** Provides the second text runtime value. */
export const SECOND_TEXT = "second";
/** Provides the devs group name runtime value. */
export const DEVS_GROUP_NAME = "devs";
/** Provides the first visit text runtime value. */
export const FIRST_VISIT_TEXT = "first visit";

/** Reports test inbound handler failures. */
export class TestInboundHandlerError extends Data.TaggedError(
  "TestInboundHandlerError",
)<{
  readonly message: string;
}> {}

/** Provides the agent runtime value. */
export const agent: (agentLabel: string) => AgentId = testAgentId;
/** Provides the conversation runtime value. */
export const conversation: (conversationLabel: string) => ConversationId =
  testConversationId;
/** Provides the message runtime value. */
export const message: (messageLabel: string) => MessageId = testMessageId;
/**
 * Provides the participant runtime value.
 * @param agentLabel Value supplied to the operation.
 * @returns The created channel core fixture.
 */
export const participant = (agentLabel: string): string =>
  "agent:" + agent(agentLabel);

/** Describes channel core fixture. */
export interface ChannelCoreFixture {
  readonly fake: FakeChannelService;
  readonly service: ChannelService;
  readonly core: MoltZapChannelCore;
  readonly inbound: EnrichedInboundMessage[];
}

/**
 * Creates channel core fixture.
 * @returns The created channel core fixture.
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
 * Executes the custom setup operation.
 * @returns The custom setup result.
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
 * Executes the force resolve agent name path operation.
 * @param fake Value supplied to the operation.
 */
export function forceResolveAgentNamePath(fake: FakeChannelService): void {
  /* Safe because the surrounding invariant establishes this asserted shape. */
  (
    fake.service as { getAgentName: (id: string) => string | undefined }
  ).getAgentName = () => undefined;
}
