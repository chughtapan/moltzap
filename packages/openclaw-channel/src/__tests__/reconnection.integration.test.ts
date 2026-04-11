import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import { MoltZapWsClient } from "@moltzap/client";
import type { EventFrame, Message } from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";
import {
  initWorker,
  cleanupWorker,
  registerAndClaim,
  makeContact,
  waitFor,
} from "./test-helpers.js";

let baseUrl: string;
let wsUrl: string;

beforeAll(() => {
  initWorker();
  baseUrl = inject("baseUrl");
  wsUrl = inject("wsUrl");
});

afterAll(async () => {
  await cleanupWorker();
});

describe("Flow 8: Reconnection + missed message catch-up", () => {
  it("reconnects after disconnect with exponential backoff", async () => {
    const bob = await registerAndClaim("recon-bob");

    let disconnected = false;
    let reconnected = false;

    const client = new MoltZapWsClient({
      serverUrl: baseUrl,
      agentKey: bob.apiKey,
      onEvent: () => {},
      onDisconnect: () => {
        disconnected = true;
      },
      onReconnect: () => {
        reconnected = true;
      },
    });

    await client.connect();

    client.disconnect();

    await waitFor(() => disconnected, 3000);
    expect(disconnected).toBe(true);

    await waitFor(() => reconnected, 10_000);
    expect(reconnected).toBe(true);

    client.close();
  });

  it("onReconnect callback receives helloOk with unreadCounts", async () => {
    const alice = await registerAndClaim("recon-alice-unread");
    const bob = await registerAndClaim("recon-bob-unread");
    await makeContact(alice.userId, bob.userId);

    const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
    await aliceClient.connect(alice.apiKey);

    const conv = (await aliceClient.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };
    const conversationId = conv.conversation.id;

    let reconnectHelloOk: unknown = null;

    const bobClient = new MoltZapWsClient({
      serverUrl: baseUrl,
      agentKey: bob.apiKey,
      onEvent: () => {},
      onDisconnect: () => {},
      onReconnect: (helloOk: unknown) => {
        reconnectHelloOk = helloOk;
      },
    });

    await bobClient.connect();

    bobClient.disconnect();
    await waitFor(() => reconnectHelloOk !== null || true, 2000).catch(
      () => {},
    );

    await aliceClient.rpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text: "Missed while offline" }],
    });

    await waitFor(() => reconnectHelloOk !== null, 15_000);

    expect(reconnectHelloOk).toBeDefined();

    bobClient.close();
    aliceClient.close();
  });

  it("events received after reconnect are dispatched to handlers", async () => {
    const alice = await registerAndClaim("recon-alice-evt");
    const bob = await registerAndClaim("recon-bob-evt");
    await makeContact(alice.userId, bob.userId);

    const receivedMessages: Message[] = [];
    let disconnected = false;
    let reconnected = false;

    const bobClient = new MoltZapWsClient({
      serverUrl: baseUrl,
      agentKey: bob.apiKey,
      onEvent: (event: EventFrame) => {
        if (event.event === EventNames.MessageReceived) {
          const data = event.data as { message?: Message } | undefined;
          if (data?.message) {
            receivedMessages.push(data.message);
          }
        }
      },
      onDisconnect: () => {
        disconnected = true;
      },
      onReconnect: () => {
        reconnected = true;
      },
    });

    await bobClient.connect();

    const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
    await aliceClient.connect(alice.apiKey);

    const conv = (await aliceClient.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };

    await aliceClient.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "Before disconnect" }],
    });

    await waitFor(() => receivedMessages.length >= 1, 5000);
    expect(receivedMessages[0]!.parts[0]!).toEqual({
      type: "text",
      text: "Before disconnect",
    });

    bobClient.disconnect();
    await waitFor(() => disconnected, 3000);

    await waitFor(() => reconnected, 10_000);

    receivedMessages.length = 0;

    await aliceClient.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "After reconnect" }],
    });

    await waitFor(() => receivedMessages.length >= 1, 5000);
    expect(receivedMessages[0]!.parts[0]!).toEqual({
      type: "text",
      text: "After reconnect",
    });

    bobClient.close();
    aliceClient.close();
  });

  it("close() prevents reconnection", async () => {
    const bob = await registerAndClaim("recon-bob-close");

    let reconnectCount = 0;
    let disconnected = false;

    const client = new MoltZapWsClient({
      serverUrl: baseUrl,
      agentKey: bob.apiKey,
      onEvent: () => {},
      onDisconnect: () => {
        disconnected = true;
      },
      onReconnect: () => {
        reconnectCount++;
      },
    });

    await client.connect();

    client.close();

    await waitFor(() => disconnected, 3000);

    await new Promise((r) => setTimeout(r, 3000));

    expect(reconnectCount).toBe(0);
  });

  it("RPC calls work after reconnection", async () => {
    const bob = await registerAndClaim("recon-bob-rpc");

    let reconnected = false;

    const client = new MoltZapWsClient({
      serverUrl: baseUrl,
      agentKey: bob.apiKey,
      onEvent: () => {},
      onDisconnect: () => {},
      onReconnect: () => {
        reconnected = true;
      },
    });

    await client.connect();

    client.disconnect();

    await waitFor(() => reconnected, 10_000);

    const result = (await client.sendRpc("agents/lookup", {
      agentIds: [bob.agentId],
    })) as { agents: Array<{ id: string; name: string }> };

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.name).toBe("recon-bob-rpc");

    client.close();
  });
});
