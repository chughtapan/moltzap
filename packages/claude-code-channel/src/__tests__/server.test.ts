/**
 * Unit tests for `server.ts` (MCP stdio server — capability handshake, tool
 * registry, notification shape, routing).
 *
 * Transplanted from zapbot `test/claude-channel-server.test.ts` (verdict
 * §(b) MOVE row 4). Tests are updated for the pruned tool set (reply only
 * in v1; no send_direct_message, no edit_message) and the fixed capability
 * declaration per spec A4 / A6 / A7 / A14.
 *
 * Architect stage: test skeletons only.
 */

import { describe, it } from "vitest";

describe("bootChannelMcpServer — capability handshake (spec A14)", () => {
  it.todo(
    "advertises capabilities { tools: {}, experimental: { 'claude/channel': {} } } at connect",
  );
  it.todo("does NOT advertise experimental['claude/channel/permission']");
});

describe("bootChannelMcpServer — tool registry (spec A4, A7)", () => {
  it.todo("registers exactly one tool: reply");
  it.todo("reply.inputSchema matches contract: text required, reply_to? files?");
  it.todo("does NOT register send_direct_message");
  it.todo("does NOT register edit_message (v1 — OQ4 default B)");
  it.todo("does NOT accept caller-injected tool definitions");
});

describe("notification emission (spec A5, A6)", () => {
  it.todo(
    "Handle.push emits method exactly 'notifications/claude/channel' with contract meta",
  );
  it.todo(
    "does NOT emit notifications/claude/channel/permission_request or /permission",
  );
  it.todo("queues notifications until MCP initialized, flushes once ready");
});

describe("reply tool routing (spec OQ5)", () => {
  it.todo("resolves reply_to present + known → that message's chat_id");
  it.todo("resolves reply_to absent → last-active chat_id");
  it.todo(
    "returns ReplyError.NoActiveChat when reply_to absent and no inbound observed",
  );
  it.todo(
    "returns ReplyError.ReplyToUnknown when reply_to does not map to a known message_id",
  );
  it.todo("never silently drops — every call either delivers or errors");
});

describe("decodeReplyArgs — boundary validation (Principle 2)", () => {
  it.todo("accepts {text: 'hi'}");
  it.todo("accepts {text, reply_to, files}");
  it.todo("rejects {text: 42} with ReplyArgsInvalid");
  it.todo("rejects missing text with ReplyArgsInvalid");
});
