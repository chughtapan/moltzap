/** @file Native Events handshake bounds and optional-cursor interoperability. */

import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type ServerContext,
  SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/server";
import {
  Deferred,
  Effect,
  Fiber,
  Stream,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import { INBOX_PENDING_EVENT } from "../harness-mcp-contract.js";
import { acquireHarnessMcpHttpServer } from "../harness-mcp-http.js";
import { inboxWakeups } from "./events.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed transport errors and draft notification names are interoperability expectations. */

const frames: ReadonlyArray<
  readonly [string, Readonly<Record<string, unknown>>]
> = [
  ["notifications/events/active", { truncated: false }],
  ["notifications/message", { level: "info", data: "unrelated log" }],
  ["notifications/events/heartbeat", {}],
  [
    "notifications/events/error",
    { error: { code: -32603, message: "UpstreamError" } },
  ],
  [
    "notifications/events/event",
    {
      eventId: "evt_test",
      name: INBOX_PENDING_EVENT,
      timestamp: "2026-09-30T00:00:00Z",
      data: { pendingCount: 1 },
    },
  ],
  [
    "notifications/events/terminated",
    { error: { code: -32012, message: "Unavailable" } },
  ],
];

const streamServer = (
  operation: (context: ServerContext) => Effect.Effect<never, unknown>,
) =>
  createMcpHandler(
    () => {
      const capabilities = { events: {}, logging: {} };
      const server = new McpServer(
        { name: "native-events-conformance", version: "1" },
        { capabilities },
      );
      server.server.setRequestHandler(
        "events/stream",
        { params: fromJsonSchema({ type: "object" }) },
        (input, context) => {
          expect(input).toMatchObject({ name: INBOX_PENDING_EVENT });
          return Effect.runPromise(operation(context), {
            signal: context.mcpReq.signal,
          });
        },
      );
      return server;
    },
    { legacy: "reject", responseMode: "auto" },
  );

const endpointFor = (handler: ReturnType<typeof createMcpHandler>) =>
  acquireHarnessMcpHttpServer({ port: 0, handler }).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      return address === null || typeof address === "string"
        ? Effect.dieMessage("Expected TCP listener")
        : Effect.succeed(new URL(`http://127.0.0.1:${address.port}/mcp`));
    }),
  );

const boundsInitialHeaders = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<undefined>();
        const handler = streamServer(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
        );
        const endpoint = yield* endpointFor(handler);
        const reader = yield* inboxWakeups(endpoint).pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust("61 seconds");
        expect((yield* Fiber.join(reader)).reason).toBe("transport-failed");
      }),
    ).pipe(Effect.provide(TestContext.TestContext)),
  );

const sendFrames = (
  context: ServerContext,
  receipts: ReadonlyArray<Deferred.Deferred<undefined>>,
) =>
  Effect.gen(function* () {
    const receiptByMethod: Readonly<
      Record<string, Deferred.Deferred<undefined> | undefined>
    > = {
      "notifications/events/active": receipts[0],
      "notifications/events/event": receipts[1],
    };
    for (const [method, params] of frames) {
      yield* Effect.tryPromise({
        try: () =>
          context.mcpReq.notify({
            method,
            params: {
              ...params,
              _meta: { [SUBSCRIPTION_ID_META_KEY]: context.mcpReq.id },
            },
          }),
        catch: () => new Error("Failed to send test frame"),
      });
      const receipt = receiptByMethod[method];
      if (receipt !== undefined) {
        yield* Deferred.await(receipt);
      }
    }
    return yield* Effect.never;
  });

const continuesAfterRecoverableErrors = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const receipts = [
          yield* Deferred.make<undefined>(),
          yield* Deferred.make<undefined>(),
        ];
        let received = 0;
        const handler = streamServer((context) =>
          sendFrames(context, receipts),
        );
        const endpoint = yield* endpointFor(handler);
        const failure = yield* inboxWakeups(endpoint).pipe(
          Stream.tap(() => {
            const receipt = receipts[received++];
            return receipt === undefined
              ? Effect.void
              : Deferred.succeed(receipt, undefined);
          }),
          Stream.runDrain,
          Effect.flip,
        );
        expect(failure.reason).toBe("transport-failed");
        expect(received).toBe(2);
      }),
    ),
  );

// @agent-code-guard/regression-only: these real HTTP transcripts pin external framing and bounded startup, without mocking transport methods.
describe("native MCP Events reception", () => {
  it(
    "bounds a connection whose server withholds HTTP headers",
    boundsInitialHeaders,
  );
  it(
    "accepts absent cursors, continues after recoverable errors and closes on termination",
    continuesAfterRecoverableErrors,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
