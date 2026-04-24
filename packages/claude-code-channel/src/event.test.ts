/**
 * Unit tests for `event.ts` (meta-key mapping).
 *
 * Transplanted from zapbot `test/claude-channel-event.test.ts` (verdict
 * §(b) MOVE row 3). Tests are updated to assert the contract-correct meta
 * keys (`chat_id`, `user`, `message_id`, `ts`) per spec A12; behavioral
 * assertions otherwise unchanged.
 *
 * Architect stage: test skeletons only (`it.todo`). implement-staff fills
 * in bodies.
 */

import { describe, it } from "vitest";

describe("toClaudeChannelNotification — meta-key mapping", () => {
  it.todo("maps conversationId → chat_id verbatim");
  it.todo("maps sender.id → user verbatim");
  it.todo("maps inbound .id → message_id verbatim");
  it.todo("maps createdAt (ISO string) → ts verbatim");
  it.todo("emits method exactly 'notifications/claude/channel'");
  it.todo("rejects with ContentEmpty when text is blank-only");
  it.todo("passes file_path through when present, omits key when absent");
  it.todo("does not emit zapbot's invented keys (conversation_id, sender_id, received_at_ms)");
});

describe("branded-type narrowers", () => {
  it.todo("brandChatId rejects empty string");
  it.todo("brandIsoTimestamp rejects non-ISO strings");
});
