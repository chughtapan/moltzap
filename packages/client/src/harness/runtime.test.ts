/* eslint-disable agent-code-guard/async-keyword -- The official MCP SDK exposes Promise-native client and handler lifecycle APIs at this interoperability boundary. */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { conversationSearch } from "@moltzap/protocol/conversation";
import type { Message } from "@moltzap/protocol/message";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import { acquireHarnessMcpHttpServer } from "../harness-mcp-server.js";
import {
  decodeHarnessReplyRoute,
  decodeHarnessSearchConversationsResult,
  decodeHarnessStartConversationResult,
  decodeHarnessTurnEvent,
  HARNESS_EVENTS_EXTENSION,
  HARNESS_REPLY_TOOL,
  harnessStartConversationInputJsonSchema,
  harnessReplyInputJsonSchema,
  harnessReplyRequestMeta,
  harnessReplyResultJsonSchema,
  harnessTurnConversationId,
  type HarnessReplyInput,
  type HarnessReplyResult,
  type HarnessReplyRoute,
} from "./runtime.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000001");
const SENDER_ID = agentId("00000000-0000-4000-8000-000000000003");

const firstMessage = {
  id: messageId("00000000-0000-4000-8000-000000000004"),
  conversationId: CONVERSATION_ID,
  senderId: SENDER_ID,
  parts: [{ type: "text", text: "first" }],
  createdAt: "2026-08-03T12:00:00.000Z",
} satisfies Message;

const secondMessage = {
  id: messageId("00000000-0000-4000-8000-000000000005"),
  conversationId: CONVERSATION_ID,
  senderId: SENDER_ID,
  parts: [{ type: "text", text: "second" }],
  createdAt: "2026-08-03T12:00:01.000Z",
} satisfies Message;

const otherConversationMessage = {
  ...secondMessage,
  conversationId: conversationId("00000000-0000-4000-8000-000000000002"),
} satisfies Message;

const conversationWithParticipants = {
  id: CONVERSATION_ID,
  createdBy: SENDER_ID,
  participants: [SENDER_ID],
  createdAt: firstMessage.createdAt,
  updatedAt: secondMessage.createdAt,
};

const replyInputJsonSchema = fromJsonSchema<HarnessReplyInput>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessReplyInputJsonSchema as JsonSchemaType,
);

const replyResultJsonSchema = fromJsonSchema<HarnessReplyResult>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessReplyResultJsonSchema as JsonSchemaType,
);

const decodesProtocolMessageBatch = async () => {
  const turn = await Effect.runPromise(
    decodeHarnessTurnEvent({ messages: [firstMessage, secondMessage] }),
  );

  expect(turn.messages).toEqual([firstMessage, secondMessage]);
  expect(harnessTurnConversationId(turn)).toBe(CONVERSATION_ID);
  await expect(
    Effect.runPromise(decodeHarnessTurnEvent({ messages: [] })),
  ).rejects.toBeDefined();
  await expect(
    Effect.runPromise(
      decodeHarnessTurnEvent({
        messages: [firstMessage, otherConversationMessage],
      }),
    ),
  ).rejects.toBeDefined();
};

const keepsPrivateRoutingMetadataClosed = async () => {
  const requestMeta = {
    ...harnessReplyRequestMeta(CONVERSATION_ID),
    "io.modelcontextprotocol/unrelated": true,
  };
  await expect(
    Effect.runPromise(decodeHarnessReplyRoute(requestMeta)),
  ).resolves.toEqual({ conversationId: CONVERSATION_ID });
  await expect(
    Effect.runPromise(
      decodeHarnessReplyRoute({
        [HARNESS_EVENTS_EXTENSION]: {
          conversationId: CONVERSATION_ID,
          invented: true,
        },
      }),
    ),
  ).rejects.toBeDefined();
};

const keepsConversationMembershipOnMcpOnly = () => {
  const page = { conversations: [conversationWithParticipants] };
  expect(Effect.runSync(decodeHarnessSearchConversationsResult(page))).toEqual(
    page,
  );
  expect(conversationSearch.validateResult(page)).toBe(false);
};

const keepsStartConversationContractClosed = async () => {
  const result = { conversation: conversationWithParticipants };
  await expect(
    Effect.runPromise(decodeHarnessStartConversationResult(result)),
  ).resolves.toEqual(result);
  await expect(
    Effect.runPromise(
      decodeHarnessStartConversationResult({
        conversation: {
          ...conversationWithParticipants,
          participants: undefined,
        },
      }),
    ),
  ).rejects.toBeDefined();
  await expect(
    Effect.runPromise(
      decodeHarnessStartConversationResult({ ...result, invented: true }),
    ),
  ).rejects.toBeDefined();

  expect(harnessStartConversationInputJsonSchema).toMatchObject({
    type: "object",
    properties: {
      otherAgentNames: {
        type: "array",
        minItems: 1,
        items: {
          type: "string",
          minLength: 3,
          maxLength: 32,
          pattern: "^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$",
        },
      },
      initialContent: { type: "string", minLength: 1 },
    },
    required: ["otherAgentNames", "initialContent"],
    additionalProperties: false,
  });
};

interface ObservedReply {
  arguments?: unknown;
  route?: HarnessReplyRoute;
}

const makeRuntimeHandler = (observed: ObservedReply) =>
  createMcpHandler(() => {
    const server = new McpServer({
      name: "harness-runtime-test",
      version: "1.0.0",
    });
    server.registerTool(
      HARNESS_REPLY_TOOL,
      {
        inputSchema: replyInputJsonSchema,
        outputSchema: replyResultJsonSchema,
      },
      async (input, context) => {
        observed.arguments = input;
        observed.route = await Effect.runPromise(
          decodeHarnessReplyRoute(context.mcpReq._meta),
        );
        return {
          content: [{ type: "text", text: "{}" }],
          structuredContent: {},
        };
      },
    );
    return server;
  });

const assertPayloadOnlyDiscovery = async (client: Client) => {
  const replyTool = (await client.listTools()).tools.find(
    (tool) => tool.name === HARNESS_REPLY_TOOL,
  );
  expect(replyTool?.inputSchema).toMatchObject({
    type: "object",
    properties: { payload: { type: "string" } },
    required: ["payload"],
    additionalProperties: false,
  });
  expect(Object.keys(replyTool?.inputSchema.properties ?? {})).toEqual([
    "payload",
  ]);
};

const preservesPrivateRoute = async () => {
  const observed: ObservedReply = {};
  const handler = makeRuntimeHandler(observed);
  const scope = Effect.runSync(Scope.make());
  const listener = await Effect.runPromise(
    acquireHarnessMcpHttpServer({ port: 0, handler }).pipe(Scope.extend(scope)),
  );
  const address = listener.address();
  if (address === null || typeof address === "string") {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw new Error("expected a TCP test server address");
  }
  const client = new Client(
    { name: "harness-runtime-client-test", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: { pin: MODERN_PROTOCOL_VERSION },
      },
    },
  );

  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp`),
      ),
    );
    await assertPayloadOnlyDiscovery(client);

    const result = await client.callTool({
      name: HARNESS_REPLY_TOOL,
      arguments: { payload: "reply text" },
      _meta: harnessReplyRequestMeta(CONVERSATION_ID),
    });

    expect(observed.arguments).toEqual({ payload: "reply text" });
    expect(observed.route).toEqual({ conversationId: CONVERSATION_ID });
    expect(result.structuredContent).toEqual({});
  } finally {
    await client.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

// @agent-code-guard/regression-only: these examples pin the closed runtime boundary and official SDK metadata preservation.
describe("Harness MCP runtime contract", () => {
  it("decodes a nonempty batch of existing protocol messages", () =>
    decodesProtocolMessageBatch());
  it("keeps private routing metadata closed", () =>
    keepsPrivateRoutingMetadataClosed());
  it("adds conversation membership only on the MCP projection", () => {
    keepsConversationMembershipOnMcpOnly();
  });
  it("keeps start input canonical and its enriched result closed", () =>
    keepsStartConversationContractClosed());
  it("preserves the private route through an official MCP client call", () =>
    preservesPrivateRoute());
});

/* eslint-enable agent-code-guard/async-keyword -- Restore strict defaults after the Promise-native interoperability fixture. */
