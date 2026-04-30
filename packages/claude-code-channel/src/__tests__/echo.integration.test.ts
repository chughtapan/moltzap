/**
 * E2E echo integration test (spec A11).
 *
 * Pattern:
 *   - globalSetup spawns a real `@moltzap/server` standalone via spike-182's
 *     PGlite subprocess pattern; registers two agents (`A` for the channel,
 *     `B` for the peer).
 *   - Test boots the channel via the public `bootClaudeCodeChannel` entry
 *     against agent A, connects an in-process MCP client to the channel's
 *     stdio server via `InMemoryTransport` (injected through the
 *     `_testTransportFactory` test seam — issue #256), and uses an in-process
 *     `MoltZapService` as agent B to drive inbound traffic.
 *
 * Notes:
 *   - We route through `bootClaudeCodeChannel` rather than reproducing
 *     `entry.ts:106-143` inline. The `_testTransportFactory` field on
 *     `BootOptions` is the only addition to the public surface; underscore-
 *     prefixed and tagged "tests-only" so production callers do not reach
 *     for it (reviewer-256, option (a)).
 *   - Every meta assertion pins the contract key names (`chat_id`, `user`,
 *     `message_id`, `ts`) per spec A5, A6, A14.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { Effect } from "effect";
import { MoltZapService } from "@moltzap/client";
import type { Message } from "@moltzap/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { bootClaudeCodeChannel } from "../entry.js";
import type { Handle } from "../types.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface Harness {
  channelHandle: Handle;
  peerService: MoltZapService;
  mcpClient: Client;
  channelAgentId: string;
  peerAgentId: string;
  notifications: Notification[];
  peerInbox: Message[];
  conversationId: string;
  stop: () => Promise<void>;
}

async function bootHarness(): Promise<Harness> {
  const wsUrl = inject("moltzapWsUrl");
  const agentAApiKey = inject("agentAApiKey");
  const agentBApiKey = inject("agentBApiKey");
  const channelAgentId = inject("agentAAgentId");
  const peerAgentId = inject("agentBAgentId");

  const notifications: Notification[] = [];

  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();

  const boot = await bootClaudeCodeChannel({
    serverUrl: wsUrl,
    agentKey: agentAApiKey,
    logger: silentLogger,
    serverName: "test-claude-code-channel",
    instructions: "integration test",
    _testTransportFactory: () => serverTransport,
  });
  if (boot._tag === "Err") {
    throw new Error(
      `bootClaudeCodeChannel failed: ${boot.error._tag}: ${boot.error.cause}`,
    );
  }
  const channelHandle = boot.value;

  const mcpClient = new Client(
    { name: "integration-test", version: "0.1.0" },
    { capabilities: {} },
  );
  mcpClient.fallbackNotificationHandler = async (
    notification: Notification,
  ) => {
    notifications.push(notification);
  };
  await mcpClient.connect(clientTransport);

  // Peer (agent B) is a separate MoltZapService used to drive inbound traffic.
  const peerService = new MoltZapService({
    serverUrl: wsUrl,
    agentKey: agentBApiKey,
    logger: silentLogger,
  });
  const peerInbox: Message[] = [];
  peerService.on("message", (msg) => {
    peerInbox.push(msg);
  });
  await Effect.runPromise(peerService.connect());

  // Peer creates a DM with channel-agent-A.
  const convResponse = (await Effect.runPromise(
    peerService.sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: channelAgentId }],
    }),
  )) as { conversation: { id: string } };
  const conversationId = convResponse.conversation.id;

  return {
    channelHandle,
    peerService,
    mcpClient,
    channelAgentId,
    peerAgentId,
    notifications,
    peerInbox,
    conversationId,
    stop: async () => {
      try {
        await mcpClient.close();
      } catch {
        // best effort
      }
      try {
        await Effect.runPromise(channelHandle.stop());
      } catch {
        // best effort
      }
      peerService.close();
    },
  };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 10_000,
  tickMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, tickMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

describe("echo integration — @moltzap/claude-code-channel", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootHarness();
  }, 120_000);

  afterAll(async () => {
    await h.stop();
  });

  it("peer sends 'ping' → channel emits notification with contract meta keys", async () => {
    await Effect.runPromise(h.peerService.send(h.conversationId, "ping-one"));
    await waitFor(
      () =>
        h.notifications.some(
          (n) =>
            n.method === "notifications/claude/channel" &&
            (n.params as { content?: string }).content === "ping-one",
        ),
      15_000,
    );
    const n = h.notifications.find(
      (nn) =>
        nn.method === "notifications/claude/channel" &&
        (nn.params as { content?: string }).content === "ping-one",
    );
    expect(n).toBeDefined();
    const meta = (n!.params as { meta: Record<string, unknown> }).meta;
    expect(Object.keys(meta).sort()).toEqual(
      ["chat_id", "message_id", "ts", "user"].sort(),
    );
    expect(meta.chat_id).toBe(h.conversationId);
    expect(meta.user).toBe(h.peerAgentId);
    expect(typeof meta.message_id).toBe("string");
    expect(typeof meta.ts).toBe("string");
    // No zapbot-era invented keys.
    expect("conversation_id" in meta).toBe(false);
    expect("sender_id" in meta).toBe(false);
    expect("received_at_ms" in meta).toBe(false);
  });

  it("every emitted notification method equals 'notifications/claude/channel' (spec A6)", () => {
    const methods = new Set(h.notifications.map((n) => n.method));
    expect(methods).toEqual(new Set(["notifications/claude/channel"]));
  });

  it("reply tool (no reply_to) routes to last-active chat and reaches the peer", async () => {
    const inboxBefore = h.peerInbox.length;

    const result = await h.mcpClient.callTool({
      name: "reply",
      arguments: { text: "pong-one" },
    });
    expect(result.isError).not.toBe(true);

    await waitFor(() => h.peerInbox.length > inboxBefore, 10_000);
    const newMsg = h.peerInbox[h.peerInbox.length - 1];
    expect(newMsg?.conversationId).toBe(h.conversationId);
    const text = newMsg?.parts.find(
      (p): p is { type: "text"; text: string } => p.type === "text",
    )?.text;
    expect(text).toBe("pong-one");
  });

  it("reply tool with reply_to = known message_id routes to that chat", async () => {
    // The only known message_id is from the first inbound. Use it.
    const firstInbound = h.notifications.find(
      (n) => n.method === "notifications/claude/channel",
    );
    expect(firstInbound).toBeDefined();
    const meta = (firstInbound!.params as { meta: { message_id: string } })
      .meta;

    const inboxBefore = h.peerInbox.length;
    const result = await h.mcpClient.callTool({
      name: "reply",
      arguments: { text: "pong-two", reply_to: meta.message_id },
    });
    expect(result.isError).not.toBe(true);

    await waitFor(() => h.peerInbox.length > inboxBefore, 10_000);
    const newMsg = h.peerInbox[h.peerInbox.length - 1];
    const text = newMsg?.parts.find(
      (p): p is { type: "text"; text: string } => p.type === "text",
    )?.text;
    expect(text).toBe("pong-two");
  });

  it("reply tool with unknown reply_to returns tool error (isError: true)", async () => {
    const result = await h.mcpClient.callTool({
      name: "reply",
      arguments: { text: "should-error", reply_to: "unknown-message-id-xyz" },
    });
    expect(result.isError).toBe(true);
  });
});
