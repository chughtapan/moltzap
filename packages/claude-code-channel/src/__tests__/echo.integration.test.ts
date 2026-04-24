/**
 * E2E echo integration test (spec A11).
 *
 * Pattern:
 *   - globalSetup spawns a real `@moltzap/server` standalone via spike-182's
 *     PGlite subprocess pattern; registers two agents (`A` for the channel,
 *     `B` for the peer).
 *   - Test boots the channel plumbing against agent A, connects an in-process
 *     MCP client to the channel's stdio server via `InMemoryTransport`, and
 *     uses an in-process `MoltZapService` as agent B to drive inbound traffic.
 *
 * Notes:
 *   - We wire `bootChannelMcpServer` directly rather than through
 *     `bootClaudeCodeChannel` because the only way to attach the in-process
 *     MCP client is via `transportFactory` (internal seam). The wiring
 *     mirrors `entry.ts` so changes there must stay in sync.
 *   - Every meta assertion pins the contract key names (`chat_id`, `user`,
 *     `message_id`, `ts`) per spec A5, A6, A14.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { Effect } from "effect";
import {
  MoltZapChannelCore,
  MoltZapService,
  type EnrichedInboundMessage,
} from "@moltzap/client";
import type { Message } from "@moltzap/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { bootChannelMcpServer } from "../server.js";
import { createRoutingState } from "../routing.js";
import { toClaudeChannelNotification } from "../event.js";
import type { ReplyError } from "../errors.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface Harness {
  channelService: MoltZapService;
  channelCore: MoltZapChannelCore;
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

  const channelService = new MoltZapService({
    serverUrl: wsUrl,
    agentKey: agentAApiKey,
    logger: silentLogger,
  });
  const channelCore = new MoltZapChannelCore({
    service: channelService,
    logger: silentLogger,
  });
  const routing = createRoutingState();

  const sendReply = (chatId: string, text: string) =>
    channelCore.sendReply(chatId, text).pipe(
      Effect.mapError(
        (cause): ReplyError => ({
          _tag: "SendFailed",
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    );

  const boot = await bootChannelMcpServer(
    {
      serverName: "test-claude-code-channel",
      instructions: "integration test",
    },
    {
      sendReply,
      routing,
      logger: silentLogger,
      transportFactory: () => serverTransport,
    },
  );
  if (boot._tag === "Err") {
    throw new Error(
      `server boot failed: ${boot.error._tag}: ${boot.error.cause}`,
    );
  }
  const serverHandle = boot.value;

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

  // Mirror entry.ts wiring: gate → translate → record → push.
  channelCore.onInbound((enriched: EnrichedInboundMessage) =>
    Effect.gen(function* () {
      const translated = toClaudeChannelNotification(enriched);
      if (translated._tag === "Err") return;
      routing.recordInbound(
        translated.value.params.meta.message_id,
        translated.value.params.meta.chat_id,
      );
      yield* serverHandle
        .push(translated.value)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    }),
  );

  // Connect channel (agent A) + peer (agent B).
  await Effect.runPromise(channelService.connect());

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
    channelService,
    channelCore,
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
        await Effect.runPromise(serverHandle.stop());
      } catch {
        // best effort
      }
      try {
        await Effect.runPromise(channelCore.disconnect());
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
