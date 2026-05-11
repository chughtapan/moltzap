export {
  createFakeChannelService,
  type ChannelServiceEmit,
  type ChannelServiceState,
  type CreateFakeChannelServiceOptions,
  type FakeChannelService,
} from "./channel-service-fixture.js";

export {
  FakeMoltZapService,
  type RecordedCall,
  type PollHistoryResult,
} from "./fake-service.js";

export {
  createMoltZapRealClientFactory,
  type RealClientFactoryOptions,
} from "./conformance-adapter.js";

import type { Message } from "@moltzap/protocol";
import { Data, Effect } from "effect";
import { testAgentId, testConversationId, testMessageId } from "./ids.js";

export { testAgentId, testConversationId, testMessageId } from "./ids.js";

const FLUSH_DISPATCH_TURNS = 20;

class FlushDispatchChainError extends Data.TaggedError(
  "FlushDispatchChainError",
)<{
  readonly cause: unknown;
}> {}

type MessageFixtureOverrides = Omit<
  Partial<Message>,
  "id" | "conversationId" | "senderId" | "replyToId" | "taggedEntities"
> & {
  readonly id?: string;
  readonly conversationId?: string;
  readonly senderId?: string;
  readonly replyToId?: string;
  readonly taggedEntities?: ReadonlyArray<string>;
};

export function buildMessage(overrides: MessageFixtureOverrides = {}): Message {
  const { id, conversationId, senderId, replyToId, taggedEntities, ...rest } =
    overrides;
  return {
    id: testMessageId(id ?? "msg-1"),
    conversationId: testConversationId(conversationId ?? "conv-1"),
    senderId: testAgentId(senderId ?? "agent-alice"),
    parts: [{ type: "text", text: "hello" }],
    createdAt: "2026-04-10T12:00:00.000Z",
    ...(replyToId !== undefined ? { replyToId: testMessageId(replyToId) } : {}),
    ...(taggedEntities !== undefined
      ? { taggedEntities: taggedEntities.map(testAgentId) }
      : {}),
    ...rest,
  };
}

export function flushDispatchChain() {
  return Effect.runPromise(
    Effect.gen(function* () {
      for (let i = 0; i < FLUSH_DISPATCH_TURNS; i++) {
        yield* Effect.tryPromise({
          try: () => Promise.resolve(),
          catch: (cause) => new FlushDispatchChainError({ cause }),
        });
      }
    }),
  );
}
