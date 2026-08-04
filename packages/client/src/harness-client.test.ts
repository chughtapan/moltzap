/* eslint-disable agent-code-guard/async-keyword -- This loopback contract test hosts the Promise-native official MCP SDK. */
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Client } from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type Implementation,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import {
  Chunk,
  Effect,
  Exit,
  Fiber,
  JSONSchema,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { describe, expect, it, vi } from "vitest";
import { conversationSearch } from "@moltzap/protocol/conversation";
import {
  agentsSearch,
  type AgentCard,
  type AgentName,
} from "@moltzap/protocol/identity";
import {
  conversationCheckpoint,
  messagesRead,
  type Message,
} from "@moltzap/protocol/message";
import type {
  ParamsOf,
  ResultOf,
  RpcDefinitionAny,
} from "@moltzap/protocol/rpc";
import {
  agentId,
  agentName,
  conversationId,
  messageId,
} from "@moltzap/protocol/testing";
import {
  acquireHarnessClient,
  HarnessClient,
  makeHarnessClientLayer,
  type HarnessTurn,
} from "./harness-client.js";
import { acquireHarnessMcpHttpServer } from "./harness-mcp-server.js";
import {
  decodeHarnessReplyRoute,
  HARNESS_EVENTS_EXTENSION,
  HARNESS_READ_CONVERSATION_TOOL,
  HARNESS_REPLY_TOOL,
  HARNESS_SEARCH_AGENTS_TOOL,
  HARNESS_SEARCH_CONVERSATIONS_TOOL,
  HARNESS_START_CONVERSATION_TOOL,
  HARNESS_STATUS_TOOL,
  harnessSearchConversationsResultJsonSchema,
  harnessReplyInputJsonSchema,
  harnessReplyResultJsonSchema,
  harnessStartConversationInputJsonSchema,
  harnessStartConversationResultJsonSchema,
  type ConversationWithParticipants,
  type HarnessReplyInput,
  type HarnessReplyResult,
  type HarnessReplyRoute,
  type HarnessSearchConversationsResult,
  type HarnessStartConversationInput,
  type HarnessStartConversationResult,
  type HarnessTurnEvent,
} from "./harness/index.js";
import {
  makeHarnessMcpSubscriptionHandler,
  type HarnessMcpSubscriptionHandler,
} from "./harness-mcp-subscription.js";
import { statusCommandRpc } from "./local-daemon-rpc.js";

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
const SELF_ID = agentId("00000000-0000-4000-8000-000000000006");
const THIRD_ID = agentId("00000000-0000-4000-8000-000000000007");
const CHECKPOINT = Schema.decodeSync(conversationCheckpoint)(
  "harness-client-checkpoint",
);
const CREATED_AT = "2026-08-03T12:00:00.000Z";

const AGENTS = [
  { id: SELF_ID, name: agentName("self-agent"), status: "active" },
  { id: SENDER_ID, name: agentName("peer-agent"), status: "active" },
  { id: THIRD_ID, name: agentName("third-agent"), status: "active" },
] satisfies readonly AgentCard[];

const CONVERSATIONS = [
  {
    id: FIRST_CONVERSATION,
    name: "first dm",
    createdBy: SELF_ID,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    participants: [SELF_ID, SENDER_ID],
  },
  {
    id: SECOND_CONVERSATION,
    name: "second group",
    createdBy: SELF_ID,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    participants: [SELF_ID, SENDER_ID, THIRD_ID],
  },
] satisfies readonly ConversationWithParticipants[];

const STARTED_CONVERSATION = {
  id: conversationId("00000000-0000-4000-8000-000000000010"),
  name: "started group",
  createdBy: SELF_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  participants: [SELF_ID, SENDER_ID, THIRD_ID],
} satisfies ConversationWithParticipants;

const STARTED_WITH = [
  agentName("peer-agent"),
  agentName("third-agent"),
] satisfies readonly AgentName[];
const INITIAL_CONTENT = "hello from self";

const message = (
  id: string,
  conversation: typeof FIRST_CONVERSATION,
  text: string,
  senderId = SENDER_ID,
): Message => ({
  id: messageId(id),
  conversationId: conversation,
  senderId,
  parts: [{ type: "text", text }],
  createdAt: CREATED_AT,
});

const firstEvent = {
  messages: [
    message(
      "00000000-0000-4000-8000-000000000004",
      FIRST_CONVERSATION,
      "first",
    ),
    message(
      "00000000-0000-4000-8000-000000000008",
      FIRST_CONVERSATION,
      "queued",
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

const selfAuthoredHistory = message(
  "00000000-0000-4000-8000-000000000009",
  FIRST_CONVERSATION,
  "self-authored history",
  SELF_ID,
);

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
const searchConversationsResultSchema =
  fromJsonSchema<HarnessSearchConversationsResult>(
    /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */
    harnessSearchConversationsResultJsonSchema as JsonSchemaType,
  );
const startConversationInputSchema =
  fromJsonSchema<HarnessStartConversationInput>(
    /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessStartConversationInputJsonSchema as JsonSchemaType,
  );
const startConversationResultSchema =
  fromJsonSchema<HarnessStartConversationResult>(
    /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessStartConversationResultJsonSchema as JsonSchemaType,
  );

const effectSchemaToMcpSchema = <A>(schema: Schema.Schema.AnyNoContext) =>
  fromJsonSchema<A>(
    /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ JSONSchema.make(
      schema,
      { target: "jsonSchema2020-12" },
    ) as JsonSchemaType,
  );

type DescriptorHandler<D extends RpcDefinitionAny> = (
  input: ParamsOf<D>,
) => ResultOf<D>;

const registerDescriptorTool = <D extends RpcDefinitionAny>(
  server: McpServer,
  name: string,
  definition: D,
  handler: DescriptorHandler<D>,
): void => {
  server.registerTool(
    name,
    {
      inputSchema: effectSchemaToMcpSchema<ParamsOf<D>>(
        definition.paramsSchema,
      ),
      outputSchema: effectSchemaToMcpSchema<ResultOf<D>>(
        definition.resultSchema,
      ),
    },
    (input) => {
      const result = handler(input);
      return Effect.runPromise(
        Effect.succeed({
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        }),
      );
    },
  );
};

const registerStatusTool = (server: McpServer): void => {
  const status = {
    agentId: SELF_ID,
    connected: true,
    conversations: CONVERSATIONS.length,
  };
  server.registerTool(
    HARNESS_STATUS_TOOL,
    {
      inputSchema: effectSchemaToMcpSchema(statusCommandRpc.payloadSchema),
      outputSchema: effectSchemaToMcpSchema(statusCommandRpc.successSchema),
    },
    () =>
      Effect.runPromise(
        Effect.succeed({
          content: [{ type: "text" as const, text: JSON.stringify(status) }],
          structuredContent: status,
        }),
      ),
  );
};

const registerSearchConversationsTool = (server: McpServer): void => {
  server.registerTool(
    HARNESS_SEARCH_CONVERSATIONS_TOOL,
    {
      inputSchema: effectSchemaToMcpSchema(conversationSearch.paramsSchema),
      outputSchema: searchConversationsResultSchema,
    },
    () => {
      const result = { conversations: [...CONVERSATIONS] };
      return Effect.runPromise(
        Effect.succeed({
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        }),
      );
    },
  );
};

const registerReadPlaneTools = (server: McpServer): void => {
  registerStatusTool(server);
  registerDescriptorTool(
    server,
    HARNESS_SEARCH_AGENTS_TOOL,
    agentsSearch,
    () => ({ agents: [...AGENTS] }),
  );
  registerSearchConversationsTool(server);
  registerDescriptorTool(
    server,
    HARNESS_READ_CONVERSATION_TOOL,
    messagesRead,
    ({ conversationId }) => ({
      messages:
        conversationId === FIRST_CONVERSATION ? [selfAuthoredHistory] : [],
      checkpoint: CHECKPOINT,
    }),
  );
};

const registerStartConversationTool = (
  server: McpServer,
  observed: HarnessStartConversationInput[],
): void => {
  server.registerTool(
    HARNESS_START_CONVERSATION_TOOL,
    {
      inputSchema: startConversationInputSchema,
      outputSchema: startConversationResultSchema,
    },
    (input) => {
      observed.push(input);
      const result = { conversation: STARTED_CONVERSATION };
      return Effect.runPromise(
        Effect.succeed({
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        }),
      );
    },
  );
};

const makeHarnessHandler = (
  observed: ObservedReply[],
  advertiseExtension = true,
  observedStarts: HarnessStartConversationInput[] = [],
): HarnessMcpSubscriptionHandler<HarnessTurnEvent> => {
  const delegate = createMcpHandler(
    () => {
      const server = new McpServer(SERVER_IMPLEMENTATION, {
        capabilities: advertiseExtension
          ? { extensions: { [HARNESS_EVENTS_EXTENSION]: {} } }
          : {},
      });
      registerReadPlaneTools(server);
      registerStartConversationTool(server, observedStarts);
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
    expect(harness.agentId).toBe(SELF_ID);
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

const expectFirstTurn = (turn: HarnessTurn): void => {
  expect(turn).toMatchObject({
    id: firstEvent.messages[0].id,
    conversationId: FIRST_CONVERSATION,
    sender: { id: SENDER_ID, name: "peer-agent" },
    text: `first\n\n[queued message from peer-agent at ${CREATED_AT}]\nqueued`,
    isFromMe: false,
    createdAt: CREATED_AT,
    conversationMeta: {
      type: "dm",
      name: "first dm",
      participants: [`agent:${SELF_ID}`, `agent:${SENDER_ID}`],
    },
    contextBlocks: {},
    coalescedMessages: [
      {
        id: firstEvent.messages[0].id,
        sender: { id: SENDER_ID, name: "peer-agent" },
        text: "first",
        createdAt: CREATED_AT,
      },
      {
        id: firstEvent.messages[1].id,
        sender: { id: SENDER_ID, name: "peer-agent" },
        text: "queued",
        createdAt: CREATED_AT,
      },
    ],
  });
  expect(turn).not.toHaveProperty("messages");
};

const expectSecondTurn = (turn: HarnessTurn): void => {
  expect(turn).toMatchObject({
    conversationId: SECOND_CONVERSATION,
    conversationMeta: {
      type: "group",
      name: "second group",
      participants: [
        `agent:${SELF_ID}`,
        `agent:${SENDER_ID}`,
        `agent:${THIRD_ID}`,
      ],
    },
    contextBlocks: {
      groupMetadata: {
        type: "group",
        name: "second group",
      },
      crossConversationMessages: [
        {
          conversationId: FIRST_CONVERSATION,
          conversationName: "first dm",
          senderName: "self-agent",
          senderId: SELF_ID,
          text: "self-authored history",
          timestamp: CREATED_AT,
        },
      ],
    },
  });
};

const expectBoundReplies = (observed: readonly ObservedReply[]): void => {
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
};

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
          }).pipe(Layer.provide(KeyValueStore.layerMemory)),
        ),
      ),
    );
    expect(turns.map((turn) => turn.conversationId)).toEqual([
      FIRST_CONVERSATION,
      SECOND_CONVERSATION,
    ]);
    const [firstTurn, secondTurn] = turns;
    if (firstTurn === undefined || secondTurn === undefined) {
      throw new Error("expected two harness turns");
    }
    expectFirstTurn(firstTurn);
    expectSecondTurn(secondTurn);
    expectBoundReplies(observed);
  } finally {
    await Effect.runPromise(Scope.close(running.scope, Exit.void));
  }
};

const rejectsMissingServerExtension = async () => {
  const running = await startHarnessServer(makeHarnessHandler([], false));
  try {
    await expect(
      Effect.runPromise(
        Effect.scoped(acquireHarnessClient({ url: running.url.href })).pipe(
          Effect.provide(KeyValueStore.layerMemory),
        ),
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
    ).pipe(Effect.provide(KeyValueStore.layerMemory));
    await expect(Effect.runPromise(nextTurn)).rejects.toBeDefined();
  } finally {
    await Effect.runPromise(Scope.close(running.scope, Exit.void));
  }
};

const startsConversationWithCanonicalProjection = async () => {
  const observedStarts: HarnessStartConversationInput[] = [];
  const running = await startHarnessServer(
    makeHarnessHandler([], true, observedStarts),
  );
  try {
    const started = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* acquireHarnessClient({
            url: running.url.href,
          });
          return yield* harness.startConversation(
            STARTED_WITH,
            INITIAL_CONTENT,
          );
        }),
      ).pipe(Effect.provide(KeyValueStore.layerMemory)),
    );
    expect(observedStarts).toEqual([
      {
        otherAgentNames: STARTED_WITH,
        initialContent: INITIAL_CONTENT,
      },
    ]);
    expect(started).toEqual({
      id: STARTED_CONVERSATION.id,
      name: STARTED_CONVERSATION.name,
      createdBy: STARTED_CONVERSATION.createdBy,
      createdAt: STARTED_CONVERSATION.createdAt,
      updatedAt: STARTED_CONVERSATION.updatedAt,
    });
    expect(started).not.toHaveProperty("participants");
  } finally {
    await Effect.runPromise(Scope.close(running.scope, Exit.void));
  }
};

interface ReplyCallObservation {
  count: number;
  signal?: AbortSignal;
}

const originalClientCallTool = Reflect.get(Client.prototype, "callTool");

const makeReplyCallImplementation = (
  observation: ReplyCallObservation,
): Client["callTool"] =>
  function (this: Client, params, options) {
    if (params.name !== HARNESS_REPLY_TOOL) {
      return originalClientCallTool.call(this, params, options);
    }
    observation.count += 1;
    observation.signal = options?.signal;
    return new Promise((resolve, reject) => {
      if (observation.signal === undefined) {
        resolve({ content: [], isError: true });
        return;
      }
      observation.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("reply request aborted"));
        },
        { once: true },
      );
    });
  };

const abortsReplyCallWhenInterrupted = async () => {
  const handler = makeHarnessHandler([]);
  const running = await startHarnessServer(handler);
  const clientScope = Effect.runSync(Scope.make());
  const observation: ReplyCallObservation = {
    count: 0,
  };
  let callTool: { readonly mockRestore: () => void } | undefined;
  try {
    const harness = await Effect.runPromise(
      acquireHarnessClient({ url: running.url.href }).pipe(
        Scope.extend(clientScope),
        Effect.provide(KeyValueStore.layerMemory),
      ),
    );
    callTool = vi
      .spyOn(Client.prototype, "callTool")
      .mockImplementation(makeReplyCallImplementation(observation));
    const received = Effect.runPromise(harness.turns.pipe(Stream.runHead));
    expect(handler.publish(firstEvent)).toBe(true);
    const turn = Option.getOrThrowWith(
      await received,
      () => new Error("expected a harness turn"),
    );
    const reply = Effect.runFork(turn.reply("cancel me"));
    await vi.waitFor(() => {
      expect(observation.count).toBe(1);
    });
    await Effect.runPromise(Fiber.interrupt(reply));
    expect(observation.signal?.aborted).toBe(true);
  } finally {
    callTool?.mockRestore();
    await Effect.runPromise(Scope.close(clientScope, Exit.void));
    await Effect.runPromise(Scope.close(running.scope, Exit.void));
  }
};

// @agent-code-guard/regression-only: the scoped loopback boundary pins the canonical start projection and every reply closure to its originating turn without suppression.
describe("HarnessClient", () => {
  it("starts a conversation and projects its MCP-local result to the canonical shape", () =>
    startsConversationWithCanonicalProjection());
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
