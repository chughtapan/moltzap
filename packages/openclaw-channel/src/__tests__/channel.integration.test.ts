import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import { MoltZapChannelPlugin } from "../channel.js";
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

describe("Channel E2E", () => {
  it("Scenario 1: Connect + authenticate", async () => {
    const agentA = await registerAndClaim("channel-e2e-a1");

    const plugin = new MoltZapChannelPlugin();
    const inbound: unknown[] = [];

    await plugin.setup(
      {
        serverUrl: baseUrl,
        apiKey: agentA.apiKey,
        agentName: "channel-e2e-a1",
      },
      (envelope) => inbound.push(envelope),
    );

    await plugin.teardown();
  });

  it("Scenario 2: Receive inbound messages", async () => {
    const agentA = await registerAndClaim("channel-e2e-a2");
    const agentB = await registerAndClaim("channel-e2e-b2");
    await makeContact(agentA.userId, agentB.userId);

    const plugin = new MoltZapChannelPlugin();
    const inbound: Array<{ text: string; conversationId: string }> = [];

    await plugin.setup(
      {
        serverUrl: baseUrl,
        apiKey: agentA.apiKey,
        agentName: "channel-e2e-a2",
      },
      (envelope) => inbound.push(envelope),
    );

    const clientB = new MoltZapTestClient(baseUrl, wsUrl);
    await clientB.connect(agentB.apiKey);

    const conv = (await clientB.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: agentA.agentId }],
    })) as { conversation: { id: string } };

    // Plugin needs to reconnect to pick up the new conversation subscription
    await plugin.teardown();
    await plugin.setup(
      {
        serverUrl: baseUrl,
        apiKey: agentA.apiKey,
        agentName: "channel-e2e-a2",
      },
      (envelope) => inbound.push(envelope),
    );

    await clientB.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "Hello from B!" }],
    });

    await waitFor(() => inbound.length > 0, 5000);

    expect(inbound.length).toBe(1);
    expect(inbound[0]!.text).toBe("Hello from B!");
    expect(inbound[0]!.conversationId).toBe(conv.conversation.id);

    clientB.close();
    await plugin.teardown();
  });

  it("Scenario 3: Send outbound messages", async () => {
    const agentA = await registerAndClaim("channel-e2e-a3");
    const agentB = await registerAndClaim("channel-e2e-b3");
    await makeContact(agentA.userId, agentB.userId);

    const clientB = new MoltZapTestClient(baseUrl, wsUrl);
    await clientB.connect(agentB.apiKey);

    const conv = (await clientB.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: agentA.agentId }],
    })) as { conversation: { id: string } };

    clientB.close();
    const clientB2 = new MoltZapTestClient(baseUrl, wsUrl);
    await clientB2.connect(agentB.apiKey);

    const plugin = new MoltZapChannelPlugin();
    await plugin.setup(
      {
        serverUrl: baseUrl,
        apiKey: agentA.apiKey,
        agentName: "channel-e2e-a3",
      },
      () => {},
    );

    await plugin.send(conv.conversation.id, "Reply from A!");

    const event = await clientB2.waitForEvent("messages/received", 5000);
    const msg = (event.data as { message: { parts: Array<{ text: string }> } })
      .message;
    expect(msg.parts[0]!.text).toBe("Reply from A!");

    clientB2.close();
    await plugin.teardown();
  });

  it("Scenario 4: Reconnection after disconnect", async () => {
    const agentA = await registerAndClaim("channel-e2e-a4");
    const agentB = await registerAndClaim("channel-e2e-b4");
    await makeContact(agentA.userId, agentB.userId);

    const clientB = new MoltZapTestClient(baseUrl, wsUrl);
    await clientB.connect(agentB.apiKey);

    await clientB.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: agentA.agentId }],
    });

    let disconnected = false;
    let reconnected = false;

    const { MoltZapWsClient } = await import("../ws-client.js");
    const wsClient = new MoltZapWsClient({
      serverUrl: baseUrl,
      agentKey: agentA.apiKey,
      onEvent: () => {},
      onDisconnect: () => {
        disconnected = true;
      },
      onReconnect: () => {
        reconnected = true;
      },
    });

    await wsClient.connect();

    wsClient.disconnect();
    await waitFor(() => disconnected, 3000);
    expect(disconnected).toBe(true);

    await waitFor(() => reconnected, 10_000);
    expect(reconnected).toBe(true);

    wsClient.close();
    clientB.close();
  });

  it("Scenario 5: Auth failure with invalid API key", async () => {
    const plugin = new MoltZapChannelPlugin();

    await expect(
      plugin.setup(
        {
          serverUrl: baseUrl,
          apiKey: "moltzap_agent_" + "0".repeat(64),
          agentName: "bad-agent",
        },
        () => {},
      ),
    ).rejects.toThrow(/auth/i);

    await plugin.teardown();
  });

  it("Scenario 6: Clean teardown", async () => {
    const agentA = await registerAndClaim("channel-e2e-a6");

    const plugin = new MoltZapChannelPlugin();
    await plugin.setup(
      {
        serverUrl: baseUrl,
        apiKey: agentA.apiKey,
        agentName: "channel-e2e-a6",
      },
      () => {},
    );

    await plugin.teardown();

    await expect(
      plugin.send("00000000-0000-0000-0000-000000000000", "should fail"),
    ).rejects.toThrow(/not connected/i);
  });
});
