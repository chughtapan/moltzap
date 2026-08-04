import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type Implementation,
  type JsonSchemaType,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { Headers } from "@effect/platform";
import { Rpc } from "@effect/rpc";
import { Effect, JSONSchema, type Schema } from "effect";
import {
  conversationSearch,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import { agentsSearch } from "@moltzap/protocol/identity";
import { messagesRead } from "@moltzap/protocol/message";
import type {
  ParamsOf,
  ResultOf,
  RpcDefinitionAny,
} from "@moltzap/protocol/rpc";
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
  type HarnessReplyInput,
  type HarnessReplyResult,
  type HarnessSearchConversationsResult,
  type HarnessStartConversationInput,
  type HarnessStartConversationResult,
  type HarnessTurnEvent,
} from "./harness/index.js";
import {
  makeHarnessMcpSubscriptionHandler,
  type HarnessMcpSubscriptionHandler,
} from "./harness-mcp-subscription.js";
import {
  statusCommandRpc,
  type localDaemonCommands,
  type LocalDaemonHandlers,
} from "./local-daemon-rpc.js";

type StatusPayload = Schema.Schema.Type<typeof statusCommandRpc.payloadSchema>;
type StatusResult = Schema.Schema.Type<typeof statusCommandRpc.successSchema>;
type StatusHandler = LocalDaemonHandlers[typeof localDaemonCommands.status];
type ReplyHandler = (
  conversationId: ConversationId,
  payload: string,
) => Effect.Effect<void, unknown>;
type DescriptorHandler<D extends RpcDefinitionAny> = (
  payload: ParamsOf<D>,
) => Effect.Effect<ResultOf<D>, unknown>;
type SearchConversationsHandler = (
  payload: ParamsOf<typeof conversationSearch>,
) => Effect.Effect<HarnessSearchConversationsResult, unknown>;
type StartConversationHandler = (
  payload: HarnessStartConversationInput,
) => Effect.Effect<HarnessStartConversationResult, unknown>;

interface HarnessMcpHandlerOptions {
  readonly implementation: Implementation;
  readonly readConversation: DescriptorHandler<typeof messagesRead>;
  readonly reply: ReplyHandler;
  readonly searchAgents: DescriptorHandler<typeof agentsSearch>;
  readonly searchConversations: SearchConversationsHandler;
  readonly startConversation: StartConversationHandler;
  readonly status: StatusHandler;
}

const effectSchemaToMcpSchema = <A>(schema: Schema.Schema.AnyNoContext) =>
  fromJsonSchema<A>(
    /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ JSONSchema.make(
      schema,
      { target: "jsonSchema2020-12" },
    ) as JsonSchemaType,
  );

const statusInputSchema = fromJsonSchema<StatusPayload>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ JSONSchema.make(
    statusCommandRpc.payloadSchema,
    { target: "jsonSchema2020-12" },
  ) as JsonSchemaType,
);
const statusOutputSchema = fromJsonSchema<StatusResult>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ JSONSchema.make(
    statusCommandRpc.successSchema,
    { target: "jsonSchema2020-12" },
  ) as JsonSchemaType,
);

const replyInputSchema = fromJsonSchema<HarnessReplyInput>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessReplyInputJsonSchema as JsonSchemaType,
);
const replyOutputSchema = fromJsonSchema<HarnessReplyResult>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessReplyResultJsonSchema as JsonSchemaType,
);
const searchConversationsOutputSchema =
  fromJsonSchema<HarnessSearchConversationsResult>(
    /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessSearchConversationsResultJsonSchema as JsonSchemaType,
  );
const startConversationInputSchema =
  fromJsonSchema<HarnessStartConversationInput>(
    /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessStartConversationInputJsonSchema as JsonSchemaType,
  );
const startConversationOutputSchema =
  fromJsonSchema<HarnessStartConversationResult>(
    /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessStartConversationResultJsonSchema as JsonSchemaType,
  );

const registerDescriptorTool = <D extends RpcDefinitionAny>(
  server: McpServer,
  toolName: string,
  definition: D,
  handler: DescriptorHandler<D>,
): void => {
  const inputSchema = effectSchemaToMcpSchema<ParamsOf<D>>(
    definition.paramsSchema,
  );
  const outputSchema = effectSchemaToMcpSchema<ResultOf<D>>(
    definition.resultSchema,
  );
  server.registerTool(
    toolName,
    { inputSchema, outputSchema },
    (payload, context) =>
      Effect.runPromise(
        handler(payload).pipe(
          Effect.flatMap((result) =>
            typeof result === "object" &&
            result !== null &&
            !Array.isArray(result)
              ? Effect.succeed({
                  content: [
                    { type: "text" as const, text: JSON.stringify(result) },
                  ],
                  structuredContent: result,
                })
              : Effect.dieMessage(
                  `MCP tool ${toolName} returned non-object structured content`,
                ),
          ),
        ),
        { signal: context.mcpReq.signal },
      ),
  );
};

const registerSearchConversationsTool = (
  server: McpServer,
  handler: SearchConversationsHandler,
): void => {
  server.registerTool(
    HARNESS_SEARCH_CONVERSATIONS_TOOL,
    {
      inputSchema: effectSchemaToMcpSchema<ParamsOf<typeof conversationSearch>>(
        conversationSearch.paramsSchema,
      ),
      outputSchema: searchConversationsOutputSchema,
    },
    (payload, context) =>
      Effect.runPromise(
        handler(payload).pipe(
          Effect.map((result) => ({
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          })),
        ),
        { signal: context.mcpReq.signal },
      ),
  );
};

const registerStartConversationTool = (
  server: McpServer,
  handler: StartConversationHandler,
): void => {
  server.registerTool(
    HARNESS_START_CONVERSATION_TOOL,
    {
      inputSchema: startConversationInputSchema,
      outputSchema: startConversationOutputSchema,
    },
    (payload, context) =>
      Effect.runPromise(
        handler(payload).pipe(
          Effect.map((result) => ({
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          })),
        ),
        { signal: context.mcpReq.signal },
      ),
  );
};

const makeRegistrationServer = (implementation: Implementation): McpServer =>
  new McpServer(implementation);

const registerStatusTool = (server: McpServer, status: StatusHandler): void => {
  server.registerTool(
    HARNESS_STATUS_TOOL,
    {
      inputSchema: statusInputSchema,
      outputSchema: statusOutputSchema,
    },
    (payload) => {
      const response = status(payload, {
        clientId: 0,
        headers: Headers.empty,
      });
      const effect = Rpc.isWrapper(response) ? response.value : response;
      const runnableEffect =
        /* Safe because the local daemon handler closes over all services while HandlersFrom widens that known-empty environment to `any`. */ effect as Effect.Effect<
          StatusResult,
          unknown
        >;
      return Effect.runPromise(
        Effect.map(runnableEffect, (result) => ({
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        })),
      );
    },
  );
};

const registerReplyTool = (server: McpServer, reply: ReplyHandler): void => {
  server.registerTool(
    HARNESS_REPLY_TOOL,
    {
      inputSchema: replyInputSchema,
      outputSchema: replyOutputSchema,
    },
    (input, context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const route = yield* decodeHarnessReplyRoute(context.mcpReq._meta);
          yield* reply(route.conversationId, input.payload);
          const result: HarnessReplyResult = {};
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }),
        { signal: context.mcpReq.signal },
      ),
  );
};

const makeActiveServer = ({
  implementation,
  readConversation,
  reply,
  searchAgents,
  searchConversations,
  startConversation,
  status,
}: HarnessMcpHandlerOptions): McpServer => {
  const server = new McpServer(implementation, {
    capabilities: {
      extensions: { [HARNESS_EVENTS_EXTENSION]: {} },
    },
  });
  registerStatusTool(server, status);
  registerDescriptorTool(
    server,
    HARNESS_SEARCH_AGENTS_TOOL,
    agentsSearch,
    searchAgents,
  );
  registerSearchConversationsTool(server, searchConversations);
  registerStartConversationTool(server, startConversation);
  registerDescriptorTool(
    server,
    HARNESS_READ_CONVERSATION_TOOL,
    messagesRead,
    readConversation,
  );
  registerReplyTool(server, reply);
  return server;
};

/**
 * Creates the registration and active-agent MCP handler catalogs.
 *
 * @param options Existing daemon capabilities exposed through MCP.
 * @param options.implementation Existing MCP server identity.
 * @param options.readConversation Raw checkpointed conversation reader.
 * @param options.reply Conversation-bound raw reply handler.
 * @param options.searchAgents Agent directory search handler.
 * @param options.searchConversations Conversation directory search handler.
 * @param options.startConversation Conversation creation and initial-content handler.
 * @param options.status Existing local daemon status handler.
 * @returns The registration and active-agent HTTP handlers.
 */
export const makeHarnessMcpHttpHandlers = ({
  implementation,
  readConversation,
  reply,
  searchAgents,
  searchConversations,
  startConversation,
  status,
}: HarnessMcpHandlerOptions): {
  readonly registration: McpHttpHandler;
  readonly active: HarnessMcpSubscriptionHandler<HarnessTurnEvent>;
} => {
  const activeDelegate = createMcpHandler(
    () =>
      makeActiveServer({
        implementation,
        readConversation,
        reply,
        searchAgents,
        searchConversations,
        startConversation,
        status,
      }),
    { legacy: "reject" },
  );
  return {
    registration: createMcpHandler(
      () => makeRegistrationServer(implementation),
      { legacy: "reject" },
    ),
    active: makeHarnessMcpSubscriptionHandler({
      delegate: activeDelegate,
      implementation,
    }),
  };
};
