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
  statusCommandRpc,
  type localDaemonCommands,
  type LocalDaemonHandlers,
} from "./local-daemon-rpc.js";

const STATUS_TOOL_NAME = "status";

type StatusPayload = Schema.Schema.Type<typeof statusCommandRpc.payloadSchema>;
type StatusResult = Schema.Schema.Type<typeof statusCommandRpc.successSchema>;
type StatusHandler = LocalDaemonHandlers[typeof localDaemonCommands.status];

interface HarnessMcpHandlerOptions {
  readonly implementation: Implementation;
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

const makeRegistrationServer = (implementation: Implementation): McpServer =>
  new McpServer(implementation);

const makeActiveServer = (
  implementation: Implementation,
  status: StatusHandler,
): McpServer => {
  const server = new McpServer(implementation);
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
  return server;
};

/**
 * Creates the registration and active-agent MCP handler catalogs.
 *
 * @param options Existing daemon capabilities exposed through MCP.
 * @param options.implementation Existing MCP server identity.
 * @param options.status Existing local daemon status handler.
 * @returns The registration and active-agent HTTP handlers.
 */
export const makeHarnessMcpHttpHandlers = ({
  implementation,
  status,
}: HarnessMcpHandlerOptions): {
  readonly registration: McpHttpHandler;
  readonly active: McpHttpHandler;
} => ({
  registration: createMcpHandler(() => makeRegistrationServer(implementation), {
    legacy: "reject",
  }),
  active: createMcpHandler(() => makeActiveServer(implementation, status), {
    legacy: "reject",
  }),
});
