/**
 * @file Pins scoped loopback MCP composition, turn decoding, and the live
 * conversation-bound reply capability exposed to runtime adapters.
 */
import type { Message } from "@moltzap/protocol/message";
import { Client } from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  fromJsonSchema,
  type Implementation,
  type JsonSchemaType,
  McpServer,
} from "@modelcontextprotocol/server";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import { Chunk, Effect, Exit, Fiber, Option, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  acquireHarnessClient,
  HarnessClient,
  type HarnessTurn,
  makeHarnessClientLayer,
} from "./harness-client.js";
import { acquireHarnessMcpHttpServer } from "./harness-mcp-server.js";
import {
  type HarnessMcpSubscriptionHandler,
  makeHarnessMcpSubscriptionHandler,
} from "./harness-mcp-subscription.js";
import {
  decodeHarnessReplyRoute,
  HARNESS_EVENTS_EXTENSION,
  HARNESS_REPLY_TOOL,
  type HarnessReplyInput,
  harnessReplyInputJsonSchema,
  type HarnessReplyResult,
  harnessReplyResultJsonSchema,
  type HarnessReplyRoute,
  type HarnessTurnEvent,
} from "./harness/index.js";

/* eslint-disable agent-code-guard/async-keyword -- This loopback contract test hosts the Promise-native official MCP SDK. */

const SERVER_IMPLEMENTATION = {
  name: "harness-client-test",
  version: "1.0.0",
} satisfies Implementation;
const FIRST_CONVERSATION = conversationId(
  "00000000-0000-4000-8000-000000000001",
);
const SECOND_CONVERSATION = conversationId(
  "00000000-0000-4000-8000-000000000002",
);
const SENDER_ID = agentId("00000000-0000-4000-8000-000000000003");

const message = (
  id: string,
  conversation: typeof FIRST_CONVERSATION,
  text: string,
): Message => ({
  id: messageId(id),
  conversationId: conversation,
  senderId: SENDER_ID,
  parts: [{ type: "text", text }],
  createdAt: "2026-08-03T12:00:00.000Z",
});

const firstEvent = {
  messages: [
    message(
      "00000000-0000-4000-8000-000000000004",
      FIRST_CONVERSATION,
      "first",
    ),
  ],
} satisfies HarnessTurnEvent;
const secondEvent = {
  messages: [
    message(
      "00000000-0000-4000-8000-000000000005",
      SECOND_CONVERSATION,
      "second",
    ),
  ],
} satisfies HarnessTurnEvent;

interface ObservedReply {
  readonly input: HarnessReplyInput;
  readonly route: HarnessReplyRoute;
}

const replyInputSchema = fromJsonSchema<HarnessReplyInput>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */
  harnessReplyInputJsonSchema as JsonSchemaType,
);
const replyResultSchema = fromJsonSchema<HarnessReplyResult>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */
  harnessReplyResultJsonSchema as JsonSchemaType,
);

const makeHarnessHandler = (
  observed: ObservedReply[],
  advertiseExtension = true,
): HarnessMcpSubscriptionHandler<HarnessTurnEvent> => {
  const delegate = createMcpHandler(
    () => {
      const server = new McpServer(SERVER_IMPLEMENTATION, {
        capabilities: advertiseExtension
          ? { extensions: { [HARNESS_EVENTS_EXTENSION]: {} } }
          : {},
      });
      server.registerTool(
        HARNESS_REPLY_TOOL,
        {
          inputSchema: replyInputSchema,
          outputSchema: replyResultSchema,
        },
        (input, context) =>
          Effect.runPromise(
            decodeHarnessReplyRoute(context.mcpReq._meta).pipe(
              Effect.map((route) => {
                observed.push({ input, route });
                return {
                  content: [{ type: "text" as const, text: "{}" }],
                  structuredContent: {},
                };
              }),
            ),
          ),
      );
      return server;
    },
    { legacy: "reject" },
  );
  return makeHarnessMcpSubscriptionHandler({
    delegate,
    implementation: SERVER_IMPLEMENTATION,
  });
};

const startHarnessServer = async (
  handler: HarnessMcpSubscriptionHandler<HarnessTurnEvent>,
) => {
  const registration = createMcpHandler(
    () => new McpServer(SERVER_IMPLEMENTATION),
    { legacy: "reject" },
  );
  const scope = Effect.runSync(Scope.make());
  const server = await Effect.runPromise(
    acquireHarnessMcpHttpServer({
      port: 0,
      registrationHandler: registration,
      harnessHandler: handler,
    }).pipe(Scope.extend(scope)),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw new Error("expected a TCP test server address");
  }
  return {
    scope,
    server,
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
  };
};

const useHarness = (
  handler: HarnessMcpSubscriptionHandler<HarnessTurnEvent>,
): Effect.Effect<readonly HarnessTurn[], Error, HarnessClient> =>
  Effect.gen(function* () {
    const harness = yield* HarnessClient;
    const receive = yield* harness.turns.pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.fork,
    );
    expect(handler.publish(firstEvent)).toBe(true);
    expect(handler.publish(secondEvent)).toBe(true);
    const turns = Chunk.toReadonlyArray(yield* Fiber.join(receive));
    const originatingTurn = turns[0];
    if (originatingTurn === undefined) {
      throw new Error("expected the originating turn");
    }
    yield* originatingTurn.reply("first reply");
    yield* originatingTurn.reply("second reply");
    return turns;
  });

const preservesBoundConversation = async () => {
  const observed: ObservedReply[] = [];
  const handler = makeHarnessHandler(observed);
  const running = await startHarnessServer(handler);

  try {
    const turns = await Effect.runPromise(
      useHarness(handler).pipe(
        Effect.provide(
          makeHarnessClientLayer({
            url: running.url.href,
          }),
        ),
      ),
    );
    expect(turns.map((turn) => turn.conversationId)).toEqual([
      FIRST_CONVERSATION,
      SECOND_CONVERSATION,
    ]);
    expect(turns[0]?.messages).toEqual(firstEvent.messages);

    expect(observed).toEqual([
      {
        input: { payload: "first reply" },
        route: { conversationId: FIRST_CONVERSATION },
      },
      {
        input: { payload: "second reply" },
        route: { conversationId: FIRST_CONVERSATION },
      },
    ]);
  } finally {
    await Effect.runPromise(Scope.close(running.scope, Exit.void));
  }
};

const rejectsMissingServerExtension = async () => {
  const running = await startHarnessServer(makeHarnessHandler([], false));
  try {
    await expect(
      Effect.runPromise(
        Effect.scoped(acquireHarnessClient({ url: running.url.href })),
      ),
    ).rejects.toThrow(HARNESS_EVENTS_EXTENSION);
  } finally {
    await Effect.runPromise(Scope.close(running.scope, Exit.void));
  }
};

const rejectsUnexpectedTurnFields = async () => {
  const handler = makeHarnessHandler([]);
  const running = await startHarnessServer(handler);
  try {
    const nextTurn = Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* acquireHarnessClient({
          url: running.url.href,
        });
        const next = yield* harness.turns.pipe(Stream.runHead, Effect.fork);
        const eventWithExtraField = { ...firstEvent, invented: true };
        expect(handler.publish(eventWithExtraField)).toBe(true);
        return yield* Fiber.join(next);
      }),
    );
    await expect(Effect.runPromise(nextTurn)).rejects.toBeDefined();
  } finally {
    await Effect.runPromise(Scope.close(running.scope, Exit.void));
  }
};

const abortsReplyCallWhenInterrupted = async () => {
  const handler = makeHarnessHandler([]);
  const running = await startHarnessServer(handler);
  const clientScope = Effect.runSync(Scope.make());
  let observedSignal: AbortSignal | undefined;
  const callTool = vi
    .spyOn(Client.prototype, "callTool")
    .mockImplementation((params, options) => {
      expect(params.name).toBe(HARNESS_REPLY_TOOL);
      observedSignal = options?.signal;
      return new Promise((resolve, reject) => {
        if (observedSignal === undefined) {
          resolve({ content: [], isError: true });
          return;
        }
        observedSignal?.addEventListener(
          "abort",
          () => {
            reject(new Error("reply request aborted"));
          },
          { once: true },
        );
      });
    });
  try {
    const harness = await Effect.runPromise(
      acquireHarnessClient({ url: running.url.href }).pipe(
        Scope.extend(clientScope),
      ),
    );
    const received = Effect.runPromise(harness.turns.pipe(Stream.runHead));
    expect(handler.publish(firstEvent)).toBe(true);
    const turn = Option.getOrThrowWith(
      await received,
      () => new Error("expected a harness turn"),
    );
    const reply = Effect.runFork(turn.reply("cancel me"));
    await vi.waitFor(() => {
      expect(callTool).toHaveBeenCalledOnce();
    });
    await Effect.runPromise(Fiber.interrupt(reply));
    expect(observedSignal?.aborted).toBe(true);
  } finally {
    callTool.mockRestore();
    await Effect.runPromise(Scope.close(clientScope, Exit.void));
    await Effect.runPromise(Scope.close(running.scope, Exit.void));
  }
};

// @agent-code-guard/regression-only: the scoped loopback boundary pins every reply closure to its originating turn without suppression.
describe("HarnessClient", () => {
  it("sends every reply through the originating conversation after later turns", () =>
    preservesBoundConversation());
  it("rejects a server without the harness events extension", () =>
    rejectsMissingServerExtension());
  it("rejects unexpected fields after removing MCP notification metadata", () =>
    rejectsUnexpectedTurnFields());
  it("aborts an in-flight reply call when its Effect is interrupted", () =>
    abortsReplyCallWhenInterrupted());
});

/* eslint-enable agent-code-guard/async-keyword -- Restore strict defaults after the Promise-native interoperability fixture. */
