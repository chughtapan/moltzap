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
import type { ConversationId } from "@moltzap/protocol/conversation";
import {
  decodeHarnessReplyRoute,
  HARNESS_EVENTS_EXTENSION,
  HARNESS_REPLY_TOOL,
  harnessReplyInputJsonSchema,
  harnessReplyResultJsonSchema,
  type HarnessReplyInput,
  type HarnessReplyResult,
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

const STATUS_TOOL_NAME = "status";

type StatusPayload = Schema.Schema.Type<typeof statusCommandRpc.payloadSchema>;
type StatusResult = Schema.Schema.Type<typeof statusCommandRpc.successSchema>;
type StatusHandler = LocalDaemonHandlers[typeof localDaemonCommands.status];
type ReplyHandler = (
  conversationId: ConversationId,
  payload: string,
) => Effect.Effect<void, unknown>;

interface HarnessMcpHandlerOptions {
  readonly implementation: Implementation;
  readonly reply: ReplyHandler;
  readonly status: StatusHandler;
}

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

const makeRegistrationServer = (implementation: Implementation): McpServer =>
  new McpServer(implementation);

const registerStatusTool = (server: McpServer, status: StatusHandler): void => {
  server.registerTool(
    STATUS_TOOL_NAME,
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

const makeActiveServer = (
  implementation: Implementation,
  status: StatusHandler,
  reply: ReplyHandler,
): McpServer => {
  const server = new McpServer(implementation, {
    capabilities: {
      extensions: { [HARNESS_EVENTS_EXTENSION]: {} },
    },
  });
  registerStatusTool(server, status);
  registerReplyTool(server, reply);
  return server;
};

/**
 * Creates the registration and active-agent MCP handler catalogs.
 *
 * @param options Existing daemon capabilities exposed through MCP.
 * @param options.implementation Existing MCP server identity.
 * @param options.reply Conversation-bound raw reply handler.
 * @param options.status Existing local daemon status handler.
 * @returns The registration and active-agent HTTP handlers.
 */
export const makeHarnessMcpHttpHandlers = ({
  implementation,
  reply,
  status,
}: HarnessMcpHandlerOptions): {
  readonly registration: McpHttpHandler;
  readonly active: HarnessMcpSubscriptionHandler<HarnessTurnEvent>;
} => {
  const activeDelegate = createMcpHandler(
    () => makeActiveServer(implementation, status, reply),
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
