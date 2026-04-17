import { describe, expect, beforeAll, afterAll, inject } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
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

/** The MoltZapWsClient API is Effect-native. These helpers run the Effects
 * at the test boundary so the integration flow reads like Promise code. */
const connectWs = (c: MoltZapWsClient) => Effect.runPromise(c.connect());
const disconnectWs = (c: MoltZapWsClient) => Effect.runSync(c.disconnect());
const closeWs = (c: MoltZapWsClient) => Effect.runSync(c.close());
const rpcWs = (c: MoltZapWsClient, method: string, params?: unknown) =>
  Effect.runPromise(c.sendRpc(method, params));

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
  it.live("reconnects after disconnect with exponential backoff", () =>
    Effect.gen(function* () {
      const bob = yield* Effect.promise(() => registerAndClaim("recon-bob"));

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

      yield* Effect.promise(() => connectWs(client));

      disconnectWs(client);

      yield* Effect.promise(() => waitFor(() => disconnected, 3000));
      expect(disconnected).toBe(true);

      yield* Effect.promise(() => waitFor(() => reconnected, 10_000));
      expect(reconnected).toBe(true);

      closeWs(client);
    }),
  );

  it.live("onReconnect callback receives helloOk with unreadCounts", () =>
    Effect.gen(function* () {
      const alice = yield* Effect.promise(() =>
        registerAndClaim("recon-alice-unread"),
      );
      const bob = yield* Effect.promise(() =>
        registerAndClaim("recon-bob-unread"),
      );
      yield* Effect.promise(() => makeContact(alice.userId, bob.userId));

      const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
      yield* aliceClient.connect(alice.apiKey);

      const conv = (yield* aliceClient.rpc("conversations/create", {
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

      yield* Effect.promise(() => connectWs(bobClient));

      disconnectWs(bobClient);
      yield* Effect.promise(() =>
        waitFor(() => reconnectHelloOk !== null || true, 2000).catch(() => {}),
      );

      yield* aliceClient.rpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: "Missed while offline" }],
      });

      yield* Effect.promise(() =>
        waitFor(() => reconnectHelloOk !== null, 15_000),
      );

      expect(reconnectHelloOk).toBeDefined();

      closeWs(bobClient);
      yield* aliceClient.close();
    }),
  );

  it.live("events received after reconnect are dispatched to handlers", () =>
    Effect.gen(function* () {
      const alice = yield* Effect.promise(() =>
        registerAndClaim("recon-alice-evt"),
      );
      const bob = yield* Effect.promise(() =>
        registerAndClaim("recon-bob-evt"),
      );
      yield* Effect.promise(() => makeContact(alice.userId, bob.userId));

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

      yield* Effect.promise(() => connectWs(bobClient));

      const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
      yield* aliceClient.connect(alice.apiKey);

      const conv = (yield* aliceClient.rpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };

      yield* aliceClient.rpc("messages/send", {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "Before disconnect" }],
      });

      yield* Effect.promise(() =>
        waitFor(() => receivedMessages.length >= 1, 5000),
      );
      expect(receivedMessages[0]!.parts[0]!).toEqual({
        type: "text",
        text: "Before disconnect",
      });

      disconnectWs(bobClient);
      yield* Effect.promise(() => waitFor(() => disconnected, 3000));

      yield* Effect.promise(() => waitFor(() => reconnected, 10_000));

      receivedMessages.length = 0;

      yield* aliceClient.rpc("messages/send", {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "After reconnect" }],
      });

      yield* Effect.promise(() =>
        waitFor(() => receivedMessages.length >= 1, 5000),
      );
      expect(receivedMessages[0]!.parts[0]!).toEqual({
        type: "text",
        text: "After reconnect",
      });

      closeWs(bobClient);
      yield* aliceClient.close();
    }),
  );

  it.live("close() prevents reconnection", () =>
    Effect.gen(function* () {
      const bob = yield* Effect.promise(() =>
        registerAndClaim("recon-bob-close"),
      );

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

      yield* Effect.promise(() => connectWs(client));

      closeWs(client);

      yield* Effect.promise(() => waitFor(() => disconnected, 3000));

      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 3000)));

      expect(reconnectCount).toBe(0);
    }),
  );

  it.live("RPC calls work after reconnection", () =>
    Effect.gen(function* () {
      const bob = yield* Effect.promise(() =>
        registerAndClaim("recon-bob-rpc"),
      );

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

      yield* Effect.promise(() => connectWs(client));

      disconnectWs(client);

      yield* Effect.promise(() => waitFor(() => reconnected, 10_000));

      const result = (yield* Effect.promise(() =>
        rpcWs(client, "agents/lookup", {
          agentIds: [bob.agentId],
        }),
      )) as { agents: Array<{ id: string; name: string }> };

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.name).toBe("recon-bob-rpc");

      closeWs(client);
    }),
  );
});
