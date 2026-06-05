import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Message } from "@moltzap/protocol/message";
import { TaskConversationArchivedNotificationDefinition } from "@moltzap/protocol/conversation";
import { MessageReceivedNotificationDefinition } from "@moltzap/protocol/message";
import { FakeMoltZapService } from "../../../test-utils/fake-service.js";
import {
  buildMessage,
  testAgentId,
  testConversationId,
  testMessageId,
  testTaskId,
} from "../../../test-utils/index.js";

const CONV_A = testConversationId("dedup-conv-a");
const CONV_B = testConversationId("dedup-conv-b");
const SENDER = testAgentId("dedup-sender");
const TASK_DEDUP = testTaskId("dedup-task");
const ARCHIVED_AT = "2026-05-01T00:00:00.000Z";
const DEDUP_WINDOW_SIZE = 1000;
const DEDUP_OVERFLOW_COUNT = DEDUP_WINDOW_SIZE + 1;

type TestConversationId = ReturnType<typeof testConversationId>;

describe("MoltZapService — inbound messageId dedup", () => {
  it("property: duplicate deliveries surface once per conversation/id", () => {
    expect.hasAssertions();
    assertDuplicateDeliveriesProperty();
  });

  it("drops the second delivery of the same messageId", dropsDuplicateMessage);
  it("processes distinct messageIds independently", processesDistinctMessages);
  it(
    "treats the same messageId in different conversations as distinct",
    scopesIdsByConversation,
  );
  it("evicts the oldest entry when the window is full", evictsOldestMessage);
  it(
    "clears the dedup window when the conversation is archived",
    clearsOnArchive,
  );
  it("clears the dedup window on close", clearsOnClose);
});

function assertDuplicateDeliveriesProperty(): void {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 16 }), {
        minLength: 1,
        maxLength: 24,
      }),
      assertDuplicateDeliveriesDedup,
    ),
  );
}

function assertDuplicateDeliveriesDedup(rawIds: readonly string[]): void {
  const { seen, service } = makeObservedService();
  for (const rawId of rawIds) {
    emitMessage(service, rawId, CONV_A);
    emitMessage(service, rawId, CONV_A);
  }
  expect(seen).toHaveLength(new Set(rawIds).size);
}

function dropsDuplicateMessage(): void {
  const { seen, service } = makeObservedService();
  emitMessage(service, "dup-msg", CONV_A);
  emitMessage(service, "dup-msg", CONV_A);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.id).toBe(testMessageId("dup-msg"));
}

function processesDistinctMessages(): void {
  const { seen, service } = makeObservedService();
  emitMessage(service, "msg-first", CONV_A);
  emitMessage(service, "msg-second", CONV_A);
  expect(seen).toHaveLength(2);
  expect(seen[0]!.id).toBe(testMessageId("msg-first"));
  expect(seen[1]!.id).toBe(testMessageId("msg-second"));
}

function scopesIdsByConversation(): void {
  const { seen, service } = makeObservedService();
  emitMessage(service, "shared-id", CONV_A);
  emitMessage(service, "shared-id", CONV_B);
  expect(seen).toHaveLength(2);
}

function evictsOldestMessage(): void {
  const { seen, service } = makeObservedService();
  saturateDedupWindow(service);
  seen.length = 0;
  emitMessage(service, "evict-msg-1", CONV_A);
  expect(seen).toHaveLength(1);
  seen.length = 0;
  emitMessage(service, "evict-msg-1001", CONV_A);
  expect(seen).toHaveLength(0);
}

function clearsOnArchive(): void {
  const { seen, service } = makeObservedService();
  emitMessage(service, "archived-msg", CONV_A);
  archiveConversation(service);
  seen.length = 0;
  emitMessage(service, "archived-msg", CONV_A);
  expect(seen).toHaveLength(1);
}

function clearsOnClose(): void {
  const { seen, service } = makeObservedService();
  emitMessage(service, "pre-close-msg", CONV_A);
  service.close();
  seen.length = 0;
  emitMessage(service, "pre-close-msg", CONV_A);
  expect(seen).toHaveLength(1);
}

function makeObservedService(): {
  readonly seen: Message[];
  readonly service: FakeMoltZapService;
} {
  const service = new FakeMoltZapService();
  const seen: Message[] = [];
  service.on("message", ({ message }) => seen.push(message));
  return { seen, service };
}

function emitMessage(
  service: FakeMoltZapService,
  id: string,
  conversationId: TestConversationId,
): Message {
  const msg = buildMessage({
    id,
    conversationId,
    senderId: SENDER,
  });
  service.emitEvent(MessageReceivedNotificationDefinition, {
    taskId: TASK_DEDUP,
    message: msg,
  });
  return msg;
}

function saturateDedupWindow(service: FakeMoltZapService): void {
  for (let i = 1; i <= DEDUP_OVERFLOW_COUNT; i++) {
    emitMessage(service, `evict-msg-${i}`, CONV_A);
  }
}

function archiveConversation(service: FakeMoltZapService): void {
  service.emitEvent(TaskConversationArchivedNotificationDefinition, {
    taskId: TASK_DEDUP,
    conversationId: CONV_A,
    archivedAt: ARCHIVED_AT,
  });
}
