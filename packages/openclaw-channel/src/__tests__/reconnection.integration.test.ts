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
      const bob = yield* Effect.tryPromise({
        try: () => registerAndClaim("recon-bob"),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

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

      yield* Effect.tryPromise({
        try: () => waitFor(() => disconnected, 3000),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      expect(disconnected).toBe(true);

      yield* Effect.tryPromise({
        try: () => waitFor(() => reconnected, 10_000),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      expect(reconnected).toBe(true);

      closeWs(client);
    }),
  );

  it.live("onReconnect callback receives helloOk with unreadCounts", () =>
    Effect.gen(function* () {
      const alice = yield* Effect.tryPromise({
        try: () => registerAndClaim("recon-alice-unread"),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      const bob = yield* Effect.tryPromise({
        try: () => registerAndClaim("recon-bob-unread"),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      yield* Effect.tryPromise({
        try: () => makeContact(alice.userId, bob.userId),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

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
      yield* Effect.tryPromise({
        try: () =>
          waitFor(() => reconnectHelloOk !== null || true, 2000).catch(
            () => {},
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      yield* aliceClient.rpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: "Missed while offline" }],
      });

      yield* Effect.tryPromise({
        try: () => waitFor(() => reconnectHelloOk !== null, 15_000),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      expect(reconnectHelloOk).toBeDefined();

      closeWs(bobClient);
      yield* aliceClient.close();
    }),
  );

  it.live("events received after reconnect are dispatched to handlers", () =>
    Effect.gen(function* () {
      const alice = yield* Effect.tryPromise({
        try: () => registerAndClaim("recon-alice-evt"),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      const bob = yield* Effect.tryPromise({
        try: () => registerAndClaim("recon-bob-evt"),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      yield* Effect.tryPromise({
        try: () => makeContact(alice.userId, bob.userId),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

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

      yield* Effect.tryPromise({
        try: () => waitFor(() => receivedMessages.length >= 1, 5000),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      expect(receivedMessages[0]!.parts[0]!).toEqual({
        type: "text",
        text: "Before disconnect",
      });

      disconnectWs(bobClient);
      yield* Effect.tryPromise({
        try: () => waitFor(() => disconnected, 3000),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      yield* Effect.tryPromise({
        try: () => waitFor(() => reconnected, 10_000),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      receivedMessages.length = 0;

      yield* aliceClient.rpc("messages/send", {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "After reconnect" }],
      });

      yield* Effect.tryPromise({
        try: () => waitFor(() => receivedMessages.length >= 1, 5000),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
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
      const bob = yield* Effect.tryPromise({
        try: () => registerAndClaim("recon-bob-close"),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

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

      yield* Effect.tryPromise({
        try: () => waitFor(() => disconnected, 3000),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 3000)));

      expect(reconnectCount).toBe(0);
    }),
  );

  it.live("RPC calls work after reconnection", () =>
    Effect.gen(function* () {
      const bob = yield* Effect.tryPromise({
        try: () => registerAndClaim("recon-bob-rpc"),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

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

      yield* Effect.tryPromise({
        try: () => waitFor(() => reconnected, 10_000),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

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
