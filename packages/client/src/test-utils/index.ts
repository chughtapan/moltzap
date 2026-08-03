/**
 * @file Test helpers shared by client package unit and integration tests.
 */
// safer-arch-ignore no-public-test-helper-leak: this dedicated test-utils subpath intentionally exposes fixtures for downstream package integration tests.
export {
  createFakeChannelService,
  type ChannelServiceEmit,
  type ChannelServiceState,
  type CreateFakeChannelServiceOptions,
  type FakeChannelService,
} from "./channel-service-fixture.js";
/** Re-exports the public API from `./standalone-provisioning.js`. */
export {
  registerStandaloneAgentPair,
  type StandaloneAgentPair,
  type StandaloneAgentPairNames,
} from "./standalone-provisioning.js";
/** Re-exports the public API from `./harness.js`. */
export {
  registerAndConnect,
  type ConnectedHarnessAgent,
  type HarnessAgentClient,
} from "./harness.js";
/** Re-exports the public API from `../auth.js`. */
export { registerAgent, type RegisterResponse } from "../auth.js";

/** Re-exports the public API from `./fake-service.js`. */
export { FakeMoltZapService, type RecordedCall } from "./fake-service.js";
/** Re-exports the public API from `../config.test-utils.js`. */
export { withTestServiceConfig } from "../config.test-utils.js";

import type { Message } from "@moltzap/protocol/message";
import { serverBaseUrl, type ServerBaseUrl } from "@moltzap/protocol/network";
import { Data, Effect } from "effect";
import { testAgentId, testConversationId, testMessageId } from "./ids.js";

/** Re-exports the public API from `./ids.js`. */
export { testAgentId, testConversationId, testMessageId } from "./ids.js";

const FLUSH_DISPATCH_TURNS = 20;

/**
 * Reduce a test server's WebSocket endpoint to the base a client connects to.
 * @param wsUrl Test server WebSocket URL.
 * @returns Path-free base URL.
 */
export const stripWsPath = (wsUrl: string): ServerBaseUrl =>
  serverBaseUrl(wsUrl);

class FlushDispatchChainError extends Data.TaggedError(
  "FlushDispatchChainError",
)<{
  readonly cause: unknown;
}> {}

type MessageFixtureOverrides = Omit<
  Partial<Message>,
  "id" | "conversationId" | "senderId"
> & {
  readonly id?: string;
  readonly conversationId?: string;
  readonly senderId?: string;
};

/**
 * Build a protocol Message fixture with branded IDs and overridable fields.
 * @param overrides Optional fields to override on the default message.
 * @returns A complete Message fixture.
 */
export function buildMessage(overrides: MessageFixtureOverrides = {}): Message {
  const { id, conversationId, senderId, ...rest } = overrides;
  return {
    id: testMessageId(id ?? "msg-1"),
    conversationId: testConversationId(conversationId ?? "conv-1"),
    senderId: testAgentId(senderId ?? "agent-alice"),
    parts: [{ type: "text", text: "hello" }],
    createdAt: "2026-04-10T12:00:00.000Z",
    ...rest,
  };
}

/**
 * Effect form of {@link flushDispatchChain} for tests already running inside
 * an Effect runtime.
 */
export const flushDispatchChainEffect = Effect.gen(function* () {
  for (let i = 0; i < FLUSH_DISPATCH_TURNS; i++) {
    yield* Effect.tryPromise({
      try: () => Promise.resolve(undefined),
      catch: (cause) => new FlushDispatchChainError({ cause }),
    });
  }
}).pipe(Effect.withSpan("flushDispatchChain"));

/**
 * Let queued dispatch microtasks settle in tests.
 * @returns A Promise that resolves after the dispatch chain is flushed.
 */
export function flushDispatchChain() {
  return Effect.runPromise(flushDispatchChainEffect);
}
