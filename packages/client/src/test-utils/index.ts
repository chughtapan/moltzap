export {
  createFakeChannelService,
  type ChannelServiceEmit,
  type ChannelServiceState,
  type CreateFakeChannelServiceOptions,
  type FakeChannelService,
} from "./channel-service-fixture.js";

export {
  FakeMoltZapService,
  type CannedResponses,
  type RecordedCall,
} from "./fake-service.js";

export {
  createMoltZapRealClientFactory,
  type RealClientFactoryOptions,
} from "./conformance-adapter.js";

import type { Message } from "@moltzap/protocol";
import { Data, Effect } from "effect";

const FLUSH_DISPATCH_TURNS = 20;

class FlushDispatchChainError extends Data.TaggedError(
  "FlushDispatchChainError",
)<{
  readonly cause: unknown;
}> {}

export function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    senderId: "agent-alice",
    parts: [{ type: "text", text: "hello" }],
    createdAt: "2026-04-10T12:00:00.000Z",
    ...overrides,
  } as Message;
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
