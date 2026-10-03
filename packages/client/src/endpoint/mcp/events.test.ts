/** @file Exercises draft discovery and native inbox delivery through real HTTP. */

import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {
  Chunk,
  Deferred,
  Effect,
  Encoding,
  Fiber,
  Schema,
  Stream,
} from "effect";
import { describe, expect, it } from "vitest";
import { InboundItem } from "../../transport/collectives/inbound.js";
import { DeliveryToken } from "../../transport/history/index.js";
import { acquireHarnessEndpoint } from "../harness-endpoint/index.js";
import { type HarnessEvents, makeHarnessEvents } from "./events.js";
import { acquireHarnessMcpHttpServer } from "./http.js";
import {
  type HarnessMessageReadyEvent,
  INBOX_PENDING_EVENT,
} from "./schemas.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- External MCP error codes and consumer ownership reasons are conformance expectations. */

const implementation = { name: "events-conformance", version: "1" };
const digest = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`;
const delivery = (byte: number): HarnessMessageReadyEvent => ({
  deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", byte)),
  item: Schema.decodeUnknownSync(InboundItem)({
    kind: "multicast",
    message: {
      kind: "direct",
      postId: digest("pst_", byte),
      address: "agent:bob",
      sender: "agent:bob",
      content: [{ type: "text", text: `item ${String(byte)}` }],
    },
  }),
});

const registerInboxTools = (
  server: McpServer,
  unread: HarnessMessageReadyEvent[],
  acknowledged: string[],
) => {
  server.registerTool(
    "read_inbox",
    { inputSchema: fromJsonSchema({ type: "object" }) },
    () => ({
      content: [{ type: "text", text: "inbox" }],
      structuredContent: { items: [...unread] },
    }),
  );
  server.registerTool(
    "acknowledge_delivery",
    {
      inputSchema: fromJsonSchema<{ deliveryToken: string }>({
        type: "object",
        properties: { deliveryToken: { type: "string" } },
        required: ["deliveryToken"],
      }),
    },
    (input) => {
      acknowledged.push(input.deliveryToken);
      const index = unread.findIndex(
        (entry) => entry.deliveryToken === input.deliveryToken,
      );
      if (index >= 0) {
        unread.splice(index, 1);
      }
      return {
        content: [{ type: "text", text: "{}" }],
        structuredContent: {},
      };
    },
  );
};

/** Schedule an arrival after ownership reservation and before activation completes. */
const yieldAfterReservation = (
  gate: Effect.Semaphore,
  current: () => HarnessEvents,
): Effect.Semaphore => {
  let triggered = false;
  const arrive = Effect.suspend(() => {
    const events = current();
    if (triggered || !events.hasActiveSubscription()) {
      return Effect.void;
    }
    triggered = true;
    events.notifyPending();
    return Effect.yieldNow();
  });
  return {
    resize: (permits) => gate.resize(permits),
    take: (permits) => gate.take(permits),
    release: (permits) => gate.release(permits),
    releaseAll: gate.releaseAll,
    withPermitsIfAvailable: (permits) => gate.withPermitsIfAvailable(permits),
    withPermits: (permits) => (operation) =>
      gate.withPermits(permits)(operation).pipe(Effect.tap(arrive)),
  };
};

const acquireEventsServer = Effect.gen(function* () {
  const unread: HarnessMessageReadyEvent[] = [];
  const acknowledged: string[] = [];
  let sequence = 0;
  const attached = yield* Deferred.make<undefined>();
  const detached = yield* Deferred.make<undefined>();
  const gate = yield* Effect.makeSemaphore(1);
  const events: HarnessEvents = yield* makeHarnessEvents({
    gate: yieldAfterReservation(gate, () => events),
    registered: () => true,
    summary: () =>
      Effect.sync(() => ({
        pendingCount: unread.length,
        newestSequence: sequence,
      })),
    onActiveChange: (active) => {
      Effect.runFork(Deferred.succeed(active ? attached : detached, undefined));
    },
  });
  const handler = createMcpHandler(
    () => {
      const capabilities = { tools: {}, events: {} };
      const server = new McpServer(implementation, { capabilities });
      events.install(server.server);
      registerInboxTools(server, unread, acknowledged);
      return server;
    },
    { legacy: "reject", responseMode: "auto" },
  );
  yield* Effect.addFinalizer(() => events.close);
  const server = yield* acquireHarnessMcpHttpServer({ port: 0, handler });
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* Effect.dieMessage("Expected a TCP listener");
  }
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  return {
    endpoint,
    events,
    attached,
    detached,
    acknowledged,
    add: (item: HarnessMessageReadyEvent) => {
      unread.push(item);
      sequence += 1;
      events.notifyPending();
    },
  };
});

const rawRequest = (
  endpoint: URL,
  method: string,
  params: Readonly<Record<string, unknown>> = {},
) =>
  HttpClient.execute(
    HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-method": method,
      }),
      HttpClientRequest.bodyUnsafeJson({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: implementation,
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    ),
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.provide(NodeHttpClient.layer),
  );

const discoversDraftEvents = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { endpoint } = yield* acquireEventsServer;
        const discovery = yield* rawRequest(endpoint, "server/discover");
        expect(discovery).toMatchObject({
          result: { capabilities: { events: {} } },
        });
        const catalog = yield* rawRequest(endpoint, "events/list");
        const pushDelivery: unknown = expect.arrayContaining(["push"]);
        expect(catalog).toHaveProperty(
          "result.events",
          expect.arrayContaining([
            expect.objectContaining({
              name: INBOX_PENDING_EVENT,
              delivery: pushDelivery,
            }),
          ]),
        );
        const missing = yield* rawRequest(endpoint, "events/stream", {
          name: "missing",
          arguments: {},
        });
        expect(missing).toMatchObject({
          error: { code: -32011, data: { kind: "event" } },
        });
        const replay = yield* rawRequest(endpoint, "events/stream", {
          name: INBOX_PENDING_EVENT,
          arguments: {},
          cursor: "stale",
        });
        expect(replay).toMatchObject({ error: { code: -32014 } });
      }),
    ),
  );

const acceptsOmittedSubscribeCursor = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { endpoint } = yield* acquireEventsServer;
        const omittedCursor = yield* rawRequest(endpoint, "events/subscribe", {
          name: "moltzap.inbox.item",
          arguments: {},
          delivery: {
            mode: "webhook",
            url: "https://callback.example/events",
            secret: "unavailable",
          },
        });
        expect(omittedCursor).toMatchObject({
          error: { code: -32014, data: { feature: "deliveryMode" } },
        });
      }),
    ),
  );

const catchesUpAndDrainsNewArrivals = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* acquireEventsServer;
        harness.add(delivery(1));
        const endpoint = yield* acquireHarnessEndpoint(harness.endpoint);
        const firstAccepted = yield* Deferred.make<undefined>();
        const received = yield* endpoint.messages.pipe(
          Stream.tap((item) =>
            item.acknowledge.pipe(
              Effect.zipRight(Deferred.succeed(firstAccepted, undefined)),
            ),
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(firstAccepted);
        harness.add(delivery(2));
        harness.events.notifyPending();
        harness.events.notifyPending();
        const items = yield* Fiber.join(received);
        expect(Chunk.toReadonlyArray(items).map((item) => item.item)).toEqual([
          delivery(1).item,
          delivery(2).item,
        ]);
        expect(harness.acknowledged).toEqual([
          delivery(1).deliveryToken,
          delivery(2).deliveryToken,
        ]);
      }),
    ),
  );

const preservesExclusiveOwnership = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* acquireEventsServer;
        const first = yield* acquireHarnessEndpoint(harness.endpoint);
        const second = yield* acquireHarnessEndpoint(harness.endpoint);
        const running = yield* first.messages.pipe(
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.await(harness.attached);
        const refused = yield* second.messages.pipe(
          Stream.runHead,
          Effect.flip,
        );
        expect(refused.reason).toBe("already-listening");
        yield* Fiber.interrupt(running);
        yield* Deferred.await(harness.detached);
        harness.add(delivery(3));
        const replay = yield* second.messages.pipe(
          Stream.take(1),
          Stream.runCollect,
        );
        expect(Chunk.toReadonlyArray(replay).map((item) => item.item)).toEqual([
          delivery(3).item,
        ]);
      }),
    ),
  );

// @agent-code-guard/regression-only: these finite protocol transcripts pin interoperability with the official SDK and real loopback HTTP.
describe("MCP Events draft interoperability", () => {
  it(
    "accepts an omitted subscription cursor before applying delivery policy",
    acceptsOmittedSubscribeCursor,
  );
  it(
    "advertises discovery and preserves draft errors for unknown events and replay",
    discoversDraftEvents,
  );
  it(
    "catches up unread items and coalesces later wakeups without implicit acknowledgment",
    catchesUpAndDrainsNewArrivals,
  );
  it(
    "refuses a competing consumer and releases ownership on cancellation",
    preservesExclusiveOwnership,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
