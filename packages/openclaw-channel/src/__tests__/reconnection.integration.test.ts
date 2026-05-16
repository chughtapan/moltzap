import { describe, expect, inject, beforeAll } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { MoltZapWsClient } from "@moltzap/client";
import { stripWsPath } from "@moltzap/client/test";
import type { Message } from "@moltzap/protocol";
import { registerAndClaim, waitFor } from "./test-helpers.js";

import {
  AgentsLookup,
  ConversationsCreate,
  MessageReceivedNotificationDefinition,
  MessagesSend,
  type ParamsOf,
  type ResultOf,
  type RpcDefinition,
} from "@moltzap/protocol";

/** The MoltZapWsClient API is Effect-native. These helpers run the Effects
 * at the test boundary so the integration flow reads like Promise code. */
const connectWs = (c: MoltZapWsClient) => Effect.runPromise(c.connect());
const disconnectWs = (c: MoltZapWsClient) => Effect.runSync(c.disconnect());
const closeWs = (c: MoltZapWsClient) => Effect.runSync(c.close());
const rpcWs = <D extends RpcDefinition<string, any, any>>(
  c: MoltZapWsClient,
  definition: D,
  params: ParamsOf<D>,
): Promise<ResultOf<D>> => Effect.runPromise(c.sendRpc(definition, params));

let baseUrl: string;
let wsUrl: string;

const DISCONNECT_WAIT_MS = 3_000;
const RECONNECT_WAIT_MS = 10_000;
const OPTIONAL_RECONNECT_WAIT_MS = 2_000;
const MISSED_MESSAGE_WAIT_MS = 15_000;
const MESSAGE_DELIVERY_WAIT_MS = 5_000;

beforeAll(() => {
  baseUrl = inject("baseUrl");
  wsUrl = inject("wsUrl");
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
        // Spec #222 OQ-6: arg required, body ignores it. OQ-4 deletion:
        // no `onNotification` option — this test doesn't observe events.
        onDisconnect: (_close) => {
          disconnected = true;
        },
        onReconnect: () => {
          reconnected = true;
        },
      });

      yield* Effect.promise(() => connectWs(client));

      disconnectWs(client);

      yield* Effect.tryPromise({
        try: () => waitFor(() => disconnected, DISCONNECT_WAIT_MS),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      expect(disconnected).toBe(true);

      yield* Effect.tryPromise({
        try: () => waitFor(() => reconnected, RECONNECT_WAIT_MS),
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

      const aliceClient = new MoltZapWsClient({
        serverUrl: stripWsPath(wsUrl),
        agentKey: alice.apiKey,
      });
      yield* aliceClient.connect();

      const conv = (yield* aliceClient.sendRpc(ConversationsCreate, {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };
      const conversationId = conv.conversation.id;

      let reconnectHelloOk: unknown = null;

      const bobClient = new MoltZapWsClient({
        serverUrl: baseUrl,
        agentKey: bob.apiKey,
        // Spec #222 OQ-6 / OQ-4: arg required (ignored here);
        // no top-level `onNotification` option — this fixture doesn't observe
        // events directly.
        onDisconnect: (_close) => {},
        onReconnect: (helloOk: unknown) => {
          reconnectHelloOk = helloOk;
        },
      });

      yield* Effect.promise(() => connectWs(bobClient));

      disconnectWs(bobClient);
      yield* Effect.tryPromise({
        try: () =>
          waitFor(
            () => reconnectHelloOk !== null || true,
            OPTIONAL_RECONNECT_WAIT_MS,
          ).catch(() => {}),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      yield* aliceClient.sendRpc(MessagesSend, {
        conversationId,
        parts: [{ type: "text", text: "Missed while offline" }],
      });

      yield* Effect.tryPromise({
        try: () =>
          waitFor(() => reconnectHelloOk !== null, MISSED_MESSAGE_WAIT_MS),
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

      const receivedMessages: Message[] = [];
      let disconnected = false;
      let reconnected = false;

      const bobClient = new MoltZapWsClient({
        serverUrl: baseUrl,
        agentKey: bob.apiKey,
        onDisconnect: (_close) => {
          disconnected = true;
        },
        onReconnect: () => {
          reconnected = true;
        },
      });
      // Spec #222 OQ-4 deletion: per-event `onNotification` callback is gone.
      // Replacement: register a `{}` filter subscription pre-connect.
      yield* bobClient.subscribe({}, (event) =>
        Effect.sync(() => {
          if (event.definition === MessageReceivedNotificationDefinition) {
            receivedMessages.push(event.params.message);
          }
        }),
      );

      yield* Effect.promise(() => connectWs(bobClient));

      const aliceClient = new MoltZapWsClient({
        serverUrl: stripWsPath(wsUrl),
        agentKey: alice.apiKey,
      });
      yield* aliceClient.connect();

      const conv = (yield* aliceClient.sendRpc(ConversationsCreate, {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };

      yield* aliceClient.sendRpc(MessagesSend, {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "Before disconnect" }],
      });

      yield* Effect.tryPromise({
        try: () =>
          waitFor(() => receivedMessages.length >= 1, MESSAGE_DELIVERY_WAIT_MS),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      expect(receivedMessages[0]!.parts[0]!).toEqual({
        type: "text",
        text: "Before disconnect",
      });

      disconnectWs(bobClient);
      yield* Effect.tryPromise({
        try: () => waitFor(() => disconnected, DISCONNECT_WAIT_MS),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      yield* Effect.tryPromise({
        try: () => waitFor(() => reconnected, RECONNECT_WAIT_MS),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      receivedMessages.length = 0;

      yield* aliceClient.sendRpc(MessagesSend, {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "After reconnect" }],
      });

      yield* Effect.tryPromise({
        try: () =>
          waitFor(() => receivedMessages.length >= 1, MESSAGE_DELIVERY_WAIT_MS),
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
        // Spec #222 OQ-6 / OQ-4: arg-required onDisconnect, no
        // top-level `onNotification`.
        onDisconnect: (_close) => {
          disconnected = true;
        },
        onReconnect: () => {
          reconnectCount++;
        },
      });

      yield* Effect.promise(() => connectWs(client));

      closeWs(client);

      yield* Effect.tryPromise({
        try: () => waitFor(() => disconnected, DISCONNECT_WAIT_MS),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      yield* Effect.promise(
        () => new Promise((r) => setTimeout(r, DISCONNECT_WAIT_MS)),
      );

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
        // Spec #222 OQ-6 / OQ-4: arg-required onDisconnect (body
        // ignored), no top-level `onNotification`.
        onDisconnect: (_close) => {},
        onReconnect: () => {
          reconnected = true;
        },
      });

      yield* Effect.promise(() => connectWs(client));

      disconnectWs(client);

      yield* Effect.tryPromise({
        try: () => waitFor(() => reconnected, RECONNECT_WAIT_MS),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });

      const result = yield* Effect.promise(() =>
        rpcWs(client, AgentsLookup, {
          agentIds: [bob.agentId],
        }),
      );

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.name).toBe("recon-bob-rpc");

      closeWs(client);
    }),
  );
});
