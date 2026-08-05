import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type Implementation,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
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
  HARNESS_REGISTER_TOOL,
  HARNESS_REPLY_TOOL,
  HARNESS_SEARCH_AGENTS_TOOL,
  HARNESS_SEARCH_CONVERSATIONS_TOOL,
  HARNESS_START_CONVERSATION_TOOL,
  HARNESS_STATUS_TOOL,
  harnessSearchConversationsResultJsonSchema,
  harnessRegisterInputJsonSchema,
  harnessRegisterResultJsonSchema,
  harnessReplyInputJsonSchema,
  harnessReplyResultJsonSchema,
  harnessStartConversationInputJsonSchema,
  harnessStartConversationResultJsonSchema,
  harnessStatusInputJsonSchema,
  harnessStatusResultJsonSchema,
  type HarnessRegisterInput,
  type HarnessRegisterResult,
  type HarnessReplyInput,
  type HarnessReplyResult,
  type HarnessSearchConversationsResult,
  type HarnessStartConversationInput,
  type HarnessStartConversationResult,
  type HarnessStatusInput,
  type HarnessStatusResult,
  type HarnessTurnEvent,
} from "./harness/index.js";
import {
  makeHarnessMcpSubscriptionHandler,
  type HarnessMcpSubscriptionHandler,
} from "./harness-mcp-subscription.js";

type StatusPayload = HarnessStatusInput;
type StatusResult = HarnessStatusResult;
type StatusHandler = (payload: StatusPayload) => Effect.Effect<StatusResult>;
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
type RegisterHandler = (
  payload: HarnessRegisterInput,
) => Effect.Effect<HarnessRegisterResult, unknown>;

/** Everything the daemon can serve once its slot carries an identity. */
export interface HarnessActiveTools {
  readonly readConversation: DescriptorHandler<typeof messagesRead>;
  readonly reply: ReplyHandler;
  readonly searchAgents: DescriptorHandler<typeof agentsSearch>;
  readonly searchConversations: SearchConversationsHandler;
  readonly startConversation: StartConversationHandler;
  readonly status: StatusHandler;
}

/**
 * Which catalog the single `/mcp` listener presents. A slot without a
 * committed Registry identity has no service to call, so it offers only the
 * operation that gives it one.
 */
export type HarnessDaemonPhase =
  | { readonly kind: "slot" }
  | { readonly kind: "active"; readonly tools: HarnessActiveTools };

interface HarnessMcpHandlerOptions {
  readonly implementation: Implementation;
  /**
   * Read per request, not captured: the official SDK builds a fresh server for
   * every HTTP exchange, so a `tools/list` after commit already sees the
   * active catalog without the listener being rebuilt.
   */
  readonly phase: () => HarnessDaemonPhase;
  readonly register: RegisterHandler;
  readonly slotStatus: StatusHandler;
}

const effectSchemaToMcpSchema = <A>(schema: Schema.Schema.AnyNoContext) =>
  fromJsonSchema<A>(
    /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ JSONSchema.make(
      schema,
      { target: "jsonSchema2020-12" },
    ) as JsonSchemaType,
  );

const statusInputSchema = fromJsonSchema<StatusPayload>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessStatusInputJsonSchema as JsonSchemaType,
);
const statusOutputSchema = fromJsonSchema<StatusResult>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessStatusResultJsonSchema as JsonSchemaType,
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
const registerInputSchema = fromJsonSchema<HarnessRegisterInput>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessRegisterInputJsonSchema as JsonSchemaType,
);
const registerOutputSchema = fromJsonSchema<HarnessRegisterResult>(
  /* Safe because Effect and MCP expose the same JSON Schema wire shape with different array mutability declarations. */ harnessRegisterResultJsonSchema as JsonSchemaType,
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

const registerRegisterTool = (
  server: McpServer,
  register: RegisterHandler,
): void => {
  server.registerTool(
    HARNESS_REGISTER_TOOL,
    {
      inputSchema: registerInputSchema,
      outputSchema: registerOutputSchema,
    },
    (payload, context) =>
      Effect.runPromise(
        register(payload).pipe(
          Effect.map((result) => ({
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          })),
        ),
        { signal: context.mcpReq.signal },
      ),
  );
};

const registerStatusTool = (server: McpServer, status: StatusHandler): void => {
  server.registerTool(
    HARNESS_STATUS_TOOL,
    {
      inputSchema: statusInputSchema,
      outputSchema: statusOutputSchema,
    },
    (payload) =>
      Effect.runPromise(
        Effect.map(status(payload), (result) => ({
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        })),
      ),
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

const makeSlotServer = (
  implementation: Implementation,
  register: RegisterHandler,
  slotStatus: StatusHandler,
): McpServer => {
  const server = new McpServer(implementation, {
    capabilities: {
      extensions: { [HARNESS_EVENTS_EXTENSION]: {} },
    },
  });
  registerRegisterTool(server, register);
  registerStatusTool(server, slotStatus);
  return server;
};

const makeActiveServer = (
  implementation: Implementation,
  {
    readConversation,
    reply,
    searchAgents,
    searchConversations,
    startConversation,
    status,
  }: HarnessActiveTools,
): McpServer => {
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
 * Creates the daemon's single MCP handler, whose catalog follows slot state.
 *
 * @param options Existing daemon capabilities exposed through MCP.
 * @param options.implementation Existing MCP server identity.
 * @param options.phase Current slot state, re-read on every request.
 * @param options.register Registry commit handler for an identity-less slot.
 * @param options.slotStatus Status handler reporting the uncommitted slot.
 * @returns The one HTTP handler serving both catalog states.
 */
export const makeHarnessMcpHttpHandler = ({
  implementation,
  phase,
  register,
  slotStatus,
}: HarnessMcpHandlerOptions): HarnessMcpSubscriptionHandler<HarnessTurnEvent> =>
  makeHarnessMcpSubscriptionHandler({
    delegate: createMcpHandler(
      () => {
        const current = phase();
        return current.kind === "slot"
          ? makeSlotServer(implementation, register, slotStatus)
          : makeActiveServer(implementation, current.tools);
      },
      { legacy: "reject" },
    ),
    implementation,
  });
