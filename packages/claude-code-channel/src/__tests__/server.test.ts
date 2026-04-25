/**
 * Unit tests for `server.ts` — MCP stdio server behavior exercised through
 * the SDK's `InMemoryTransport` pair. Covers capability handshake (A14),
 * tool registry (A4, A7), notification shape (A5, A6), routing (OQ5), and
 * boundary validation (Principle 2).
 *
 * Transplanted from zapbot `test/claude-channel-server.test.ts` (verdict
 * §(b) MOVE row 4). Tests updated for the pruned tool set (reply only;
 * send_direct_message and edit_message deleted / omitted).
 */

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import {
  bootChannelMcpServer,
  CHANNEL_CAPABILITIES,
  decodeReplyArgs,
  REPLY_TOOL_INPUT_SCHEMA,
} from "../server.js";
import { createRoutingState } from "../routing.js";
import type { ChatId, ClaudeChannelNotification, MessageId } from "../types.js";
import type { ReplyError } from "../errors.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function setup(opts?: {
  onSendReply?: (
    chatId: string,
    text: string,
  ) => Effect.Effect<void, ReplyError>;
}) {
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const routing = createRoutingState();

  const sendReply =
    opts?.onSendReply ??
    ((_chatId: string, _text: string) => Effect.succeed(undefined as void));

  const boot = await bootChannelMcpServer(
    {
      serverName: "test-channel",
      instructions: "test-instructions",
    },
    {
      sendReply,
      routing,
      logger: silentLogger,
      transportFactory: () => serverTransport,
    },
  );
  if (boot._tag === "Err") {
    throw new Error(`boot failed: ${boot.error._tag}`);
  }
  const serverHandle = boot.value;

  const client = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} },
  );

  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (notification: Notification) => {
    notifications.push(notification);
  };

  await client.connect(clientTransport);

  return {
    serverHandle,
    client,
    routing,
    notifications,
    cleanup: async () => {
      await client.close();
      await Effect.runPromise(serverHandle.stop());
    },
  };
}

describe("bootChannelMcpServer — capability handshake (spec A14)", () => {
  it("advertises capabilities { tools: {}, experimental: { 'claude/channel': {} } }", async () => {
    const { client, cleanup } = await setup();
    try {
      const caps = client.getServerCapabilities();
      expect(caps).toBeDefined();
      expect(caps?.tools).toEqual({});
      expect(caps?.experimental).toEqual({ "claude/channel": {} });
    } finally {
      await cleanup();
    }
  });

  it("does NOT advertise experimental['claude/channel/permission']", async () => {
    const { client, cleanup } = await setup();
    try {
      const caps = client.getServerCapabilities();
      expect(caps?.experimental).not.toHaveProperty(
        "claude/channel/permission",
      );
    } finally {
      await cleanup();
    }
  });

  it("CHANNEL_CAPABILITIES constant is the contract shape (pins string literal)", () => {
    expect(CHANNEL_CAPABILITIES).toEqual({
      tools: {},
      experimental: { "claude/channel": {} },
    });
  });
});

describe("bootChannelMcpServer — tool registry (spec A4, A7)", () => {
  it("registers exactly one tool: reply", async () => {
    const { client, cleanup } = await setup();
    try {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]?.name).toBe("reply");
    } finally {
      await cleanup();
    }
  });

  it("reply.inputSchema matches contract: text required, reply_to? files?", async () => {
    const { client, cleanup } = await setup();
    try {
      const result = await client.listTools();
      const reply = result.tools.find((t) => t.name === "reply");
      expect(reply).toBeDefined();
      expect(reply?.inputSchema).toMatchObject({
        type: "object",
        properties: {
          text: { type: "string" },
          reply_to: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
        required: ["text"],
      });
    } finally {
      await cleanup();
    }
  });

  it("does NOT register send_direct_message", async () => {
    const { client, cleanup } = await setup();
    try {
      const result = await client.listTools();
      expect(result.tools.map((t) => t.name)).not.toContain(
        "send_direct_message",
      );
    } finally {
      await cleanup();
    }
  });

  it("does NOT register edit_message (v1 — OQ4 default B)", async () => {
    const { client, cleanup } = await setup();
    try {
      const result = await client.listTools();
      expect(result.tools.map((t) => t.name)).not.toContain("edit_message");
    } finally {
      await cleanup();
    }
  });

  it("REPLY_TOOL_INPUT_SCHEMA is the exported contract shape", () => {
    expect(REPLY_TOOL_INPUT_SCHEMA).toMatchObject({
      type: "object",
      properties: {
        text: { type: "string" },
        reply_to: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
    });
  });
});

describe("notification emission (spec A5, A6)", () => {
  function makeNotification(
    chatId: string,
    messageId: string,
  ): ClaudeChannelNotification {
    return {
      method: "notifications/claude/channel",
      params: {
        content: "ping",
        meta: {
          chat_id: chatId as ChatId,
          message_id: messageId as MessageId,
          user: "peer" as never,
          ts: "2026-04-24T00:00:00Z" as never,
        },
      },
    };
  }

  it("Handle.push emits method 'notifications/claude/channel' with contract meta", async () => {
    const { serverHandle, notifications, cleanup } = await setup();
    try {
      await Effect.runPromise(serverHandle.push(makeNotification("C1", "M1")));
      // Give the transport a tick to deliver.
      await new Promise((r) => setTimeout(r, 10));
      expect(notifications).toHaveLength(1);
      const n = notifications[0];
      expect(n).toBeDefined();
      expect(n!.method).toBe("notifications/claude/channel");
      const meta = (n!.params as { meta: Record<string, unknown> }).meta;
      expect(meta).toMatchObject({
        chat_id: "C1",
        message_id: "M1",
        user: "peer",
        ts: "2026-04-24T00:00:00Z",
      });
    } finally {
      await cleanup();
    }
  });

  it("notification method set under push equals exactly {'notifications/claude/channel'}", async () => {
    const { serverHandle, notifications, cleanup } = await setup();
    try {
      await Effect.runPromise(serverHandle.push(makeNotification("C1", "M1")));
      await Effect.runPromise(serverHandle.push(makeNotification("C2", "M2")));
      await new Promise((r) => setTimeout(r, 10));
      const methods = new Set(notifications.map((n) => n.method));
      expect(methods).toEqual(new Set(["notifications/claude/channel"]));
    } finally {
      await cleanup();
    }
  });
});

describe("reply tool routing (spec OQ5)", () => {
  it("resolves reply_to present + known → sends to that message's chat_id", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const { client, routing, cleanup } = await setup({
      onSendReply: (chatId, text) =>
        Effect.sync(() => {
          sent.push({ chatId, text });
        }),
    });
    try {
      routing.recordInbound("M-a" as MessageId, "C-a" as ChatId);
      routing.recordInbound("M-b" as MessageId, "C-b" as ChatId);

      const result = await client.callTool({
        name: "reply",
        arguments: { text: "hi", reply_to: "M-a" },
      });
      expect(result.isError).not.toBe(true);
      expect(sent).toEqual([{ chatId: "C-a", text: "hi" }]);
    } finally {
      await cleanup();
    }
  });

  it("resolves reply_to absent → last-active chat_id", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const { client, routing, cleanup } = await setup({
      onSendReply: (chatId, text) =>
        Effect.sync(() => {
          sent.push({ chatId, text });
        }),
    });
    try {
      routing.recordInbound("M-a" as MessageId, "C-a" as ChatId);
      routing.recordInbound("M-b" as MessageId, "C-b" as ChatId);

      const result = await client.callTool({
        name: "reply",
        arguments: { text: "hi" },
      });
      expect(result.isError).not.toBe(true);
      expect(sent).toEqual([{ chatId: "C-b", text: "hi" }]);
    } finally {
      await cleanup();
    }
  });

  it("returns tool error when reply_to absent and no inbound observed (NoActiveChat)", async () => {
    const { client, cleanup } = await setup();
    try {
      const result = await client.callTool({
        name: "reply",
        arguments: { text: "hi" },
      });
      expect(result.isError).toBe(true);
      const content = Array.isArray(result.content) ? result.content : [];
      expect(JSON.stringify(content)).toMatch(/no active chat/);
    } finally {
      await cleanup();
    }
  });

  it("returns tool error when reply_to unknown (ReplyToUnknown)", async () => {
    const { client, routing, cleanup } = await setup();
    try {
      routing.recordInbound("M-known" as MessageId, "C-known" as ChatId);
      const result = await client.callTool({
        name: "reply",
        arguments: { text: "hi", reply_to: "M-missing" },
      });
      expect(result.isError).toBe(true);
      const content = Array.isArray(result.content) ? result.content : [];
      expect(JSON.stringify(content)).toMatch(/M-missing/);
    } finally {
      await cleanup();
    }
  });

  it("never silently drops — every call delivers or returns isError", async () => {
    // Covered by the above four cases in aggregate. This test pins that the
    // default (no routing state, no arguments) returns isError:true rather
    // than a no-op Ok result.
    const { client, cleanup } = await setup();
    try {
      const result = await client.callTool({ name: "reply", arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("rejects reply with non-empty files with FilesUnsupported tool error (v1, reviewer-187)", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const { client, routing, cleanup } = await setup({
      onSendReply: (chatId, text) =>
        Effect.sync(() => {
          sent.push({ chatId, text });
        }),
    });
    try {
      routing.recordInbound("M-a" as MessageId, "C-a" as ChatId);
      const result = await client.callTool({
        name: "reply",
        arguments: { text: "hi", reply_to: "M-a", files: ["a.png", "b.png"] },
      });
      expect(result.isError).toBe(true);
      const content = Array.isArray(result.content) ? result.content : [];
      expect(JSON.stringify(content)).toMatch(/FilesUnsupported/);
      expect(JSON.stringify(content)).toMatch(/2 file\(s\)/);
      // Critical: the send side-effect MUST NOT fire when files are rejected.
      expect(sent).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("accepts reply with empty files array (equivalent to omitted)", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const { client, routing, cleanup } = await setup({
      onSendReply: (chatId, text) =>
        Effect.sync(() => {
          sent.push({ chatId, text });
        }),
    });
    try {
      routing.recordInbound("M-a" as MessageId, "C-a" as ChatId);
      const result = await client.callTool({
        name: "reply",
        arguments: { text: "hi", reply_to: "M-a", files: [] },
      });
      expect(result.isError).not.toBe(true);
      expect(sent).toEqual([{ chatId: "C-a", text: "hi" }]);
    } finally {
      await cleanup();
    }
  });

  it("surfaces ReplyError.SendFailed as tool error (isError: true)", async () => {
    const { client, routing, cleanup } = await setup({
      onSendReply: () =>
        Effect.fail<ReplyError>({
          _tag: "SendFailed",
          cause: "ws dropped",
        }),
    });
    try {
      routing.recordInbound("M-x" as MessageId, "C-x" as ChatId);
      const result = await client.callTool({
        name: "reply",
        arguments: { text: "hi" },
      });
      expect(result.isError).toBe(true);
      const content = Array.isArray(result.content) ? result.content : [];
      expect(JSON.stringify(content)).toMatch(/ws dropped/);
    } finally {
      await cleanup();
    }
  });
});

describe("decodeReplyArgs — boundary validation (Principle 2)", () => {
  it("accepts {text: 'hi'}", () => {
    const r = decodeReplyArgs({ text: "hi" });
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.text).toBe("hi");
    expect(r.value.replyTo).toBeUndefined();
    expect(r.value.files).toBeUndefined();
  });

  it("decodes {text, reply_to, files} — rejection happens at handler, not decoder", () => {
    // Decoder preserves the `files` field so the handler can emit a tagged
    // FilesUnsupported tool error. Contract surface stays intact (spec A4).
    const r = decodeReplyArgs({ text: "hi", reply_to: "M1", files: ["a.png"] });
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.text).toBe("hi");
    expect(r.value.replyTo).toBe("M1");
    expect(r.value.files).toEqual(["a.png"]);
  });

  it("rejects {text: 42} with ReplyArgsInvalid", () => {
    const r = decodeReplyArgs({ text: 42 });
    expect(r._tag).toBe("Err");
  });

  it("rejects missing text", () => {
    const r = decodeReplyArgs({});
    expect(r._tag).toBe("Err");
  });

  it("rejects non-string element in files", () => {
    const r = decodeReplyArgs({ text: "hi", files: ["a", 1] });
    expect(r._tag).toBe("Err");
  });

  it("rejects non-object input", () => {
    const r = decodeReplyArgs(null);
    expect(r._tag).toBe("Err");
  });

  it("rejects empty-string text", () => {
    const r = decodeReplyArgs({ text: "   " });
    expect(r._tag).toBe("Err");
  });

  it("rejects empty reply_to", () => {
    const r = decodeReplyArgs({ text: "hi", reply_to: "" });
    expect(r._tag).toBe("Err");
  });
});

describe("unknown tool name", () => {
  it("returns tool error for unknown tool name", async () => {
    const { client, cleanup } = await setup();
    try {
      const result = await client.callTool({
        name: "edit_message",
        arguments: { message_id: "M1", text: "hi" },
      });
      // The SDK may reject before our handler if tool is unknown to listTools;
      // accept either SDK-level rejection or our tool error.
      if ("isError" in result) {
        expect(result.isError).toBe(true);
      }
    } catch (err) {
      // SDK throws "Tool edit_message not found" — acceptable.
      expect(String(err)).toMatch(/edit_message|not found|unknown/i);
    } finally {
      await cleanup();
    }
  });
});
