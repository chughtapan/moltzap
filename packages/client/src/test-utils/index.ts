export {
  createFakeChannelService,
  type ChannelServiceEmit,
  type ChannelServiceState,
  type CreateFakeChannelServiceOptions,
  type FakeChannelService,
} from "./channel-service-fixture.js";

import type { Message } from "@moltzap/protocol";

export function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    sender: { type: "agent", id: "agent-alice" },
    seq: 1,
    parts: [{ type: "text", text: "hello" }],
    createdAt: "2026-04-10T12:00:00.000Z",
    ...overrides,
  } as Message;
}

export async function flushDispatchChain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}
