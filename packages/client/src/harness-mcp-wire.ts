/** @file Official MCP tool catalog and private Harness operation projection. */

import {
  createMcpHandler,
  fromJsonSchema,
  type Implementation,
  type JsonSchemaType,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type StandardSchemaV1,
} from "@modelcontextprotocol/server";
import { Ed25519PublicKey } from "@moltzap/identity";
import { Effect, Either, Schema } from "effect";
import type { Content } from "./contract.js";
import {
  type HarnessMcpSubscriptionHandler,
  makeHarnessMcpSubscriptionHandler,
} from "./harness-mcp-subscription.js";
import {
  decodeHarnessReplyRequestMeta,
  HARNESS_EVENTS_EXTENSION,
  HARNESS_REPLY_TOOL,
  HARNESS_START_TOOL,
  type HarnessEmptyResult,
  harnessEmptyResultJsonSchema,
  type HarnessReplyRequest,
  harnessReplyRequestJsonSchema,
  type HarnessStartRequest,
  harnessStartRequestJsonSchema,
  type HarnessTurnEvent,
  type ReplyGrant,
} from "./harness-runtime.js";
import {
  managementJsonSchemas,
  type ManagementReadConversationRequest,
  type ManagementReadConversationResult,
  type ManagementRegisterRequest,
  type ManagementRegisterResult,
  type ManagementSearchAgentsRequest,
  type ManagementSearchAgentsResult,
  type ManagementSearchConversationsRequest,
  type ManagementSearchConversationsResult,
  type ManagementStatusResult,
} from "./management-runtime.js";

/* eslint-disable agent-code-guard/async-keyword -- Official MCP factories and callbacks are Promise-native. */

const REGISTER_TOOL = "register";
const STATUS_TOOL = "status";
const SEARCH_AGENTS_TOOL = "search_agents";
const SEARCH_CONVERSATIONS_TOOL = "search_conversations";
const READ_CONVERSATION_TOOL = "read_conversation";

type ClosedOperationError = Readonly<{ readonly reason: string }>;

/** Structural daemon operations projected onto the loopback MCP boundary. */
export interface HarnessMcpOperations {
  readonly readStatus: () => Effect.Effect<
    ManagementStatusResult,
    ClosedOperationError
  >;
  readonly register: (
    input: ManagementRegisterRequest,
  ) => Effect.Effect<ManagementRegisterResult, ClosedOperationError>;
  readonly searchAgents: (
    input: ManagementSearchAgentsRequest,
  ) => Effect.Effect<ManagementSearchAgentsResult, ClosedOperationError>;
  readonly searchConversations: (
    input: ManagementSearchConversationsRequest,
  ) => Effect.Effect<ManagementSearchConversationsResult, ClosedOperationError>;
  readonly readConversation: (
    input: ManagementReadConversationRequest,
  ) => Effect.Effect<ManagementReadConversationResult, ClosedOperationError>;
  readonly start: (
    input: HarnessStartRequest,
  ) => Effect.Effect<void, ClosedOperationError>;
  readonly reply: (
    grant: ReplyGrant,
    content: Content,
  ) => Effect.Effect<void, ClosedOperationError>;
}

interface HarnessMcpHandlerOptions {
  readonly implementation: Implementation;
  readonly operations: HarnessMcpOperations;
  readonly registrySignerPublicKey: Ed25519PublicKey;
  readonly onSubscriptionActiveChange?: (active: boolean) => void;
  readonly onerror?: (error: Error) => void;
}

interface ActiveCatalogState {
  active: boolean;
}

interface RunOperationOptions<Value extends Readonly<Record<string, unknown>>> {
  readonly operation: Effect.Effect<Value, ClosedOperationError>;
  readonly label: string;
  readonly allowedReasons: ReadonlySet<string>;
  readonly fallbackReason: string;
  readonly signal: AbortSignal;
}

const makeStandardSchema = <Value>(jsonSchema: unknown) =>
  fromJsonSchema<Value>(
    // Effect and MCP consume the same immutable JSON Schema document here.
    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- JSONSchema.make emits the exact JsonSchemaType consumed by the pinned MCP SDK.
    jsonSchema as JsonSchemaType,
  );

const registerInput = makeStandardSchema<ManagementRegisterRequest>(
  managementJsonSchemas.registerRequest,
);
const registerOutput = makeStandardSchema<ManagementRegisterResult>(
  managementJsonSchemas.registerResult,
);
const emptyInput = makeStandardSchema<Record<string, never>>(
  managementJsonSchemas.emptyRequest,
);
const statusOutput = makeStandardSchema<ManagementStatusResult>(
  managementJsonSchemas.statusResult,
);
const searchAgentsInput = makeStandardSchema<ManagementSearchAgentsRequest>(
  managementJsonSchemas.searchAgentsRequest,
);
const searchAgentsOutput = makeStandardSchema<ManagementSearchAgentsResult>(
  managementJsonSchemas.searchAgentsResult,
);
const searchConversationsInput =
  makeStandardSchema<ManagementSearchConversationsRequest>(
    managementJsonSchemas.searchConversationsRequest,
  );
const searchConversationsOutput =
  makeStandardSchema<ManagementSearchConversationsResult>(
    managementJsonSchemas.searchConversationsResult,
  );
const readConversationInput =
  makeStandardSchema<ManagementReadConversationRequest>(
    managementJsonSchemas.readConversationRequest,
  );
const readConversationOutput =
  makeStandardSchema<ManagementReadConversationResult>(
    managementJsonSchemas.readConversationResult,
  );
const startInput = makeStandardSchema<HarnessStartRequest>(
  harnessStartRequestJsonSchema,
);
const replyInput = makeStandardSchema<HarnessReplyRequest>(
  harnessReplyRequestJsonSchema,
);
const emptyOutput = makeStandardSchema<HarnessEmptyResult>(
  harnessEmptyResultJsonSchema,
);

const REGISTER_REASONS = new Set(["upstream", "persistence", "representation"]);
const STATUS_REASONS = new Set(["persistence", "representation"]);
const SEARCH_AGENTS_REASONS = new Set(["upstream", "representation"]);
const SEARCH_CONVERSATIONS_REASONS = new Set(["persistence"]);
const READ_CONVERSATION_REASONS = new Set([
  "not-found",
  "invalid-continuation",
  "persistence",
  "representation",
]);
const START_REASONS = new Set([
  "intent-conflict",
  "not-registered",
  "membership",
  "persistence",
  "durability",
  "reanchor",
  "representation",
]);
const REPLY_REASONS = new Set([
  "authority-unavailable",
  "persistence",
  "durability",
  "reanchor",
  "representation",
]);

const operationReason = (
  cause: unknown,
  allowed: ReadonlySet<string>,
  fallback: string,
): string => {
  if (typeof cause !== "object" || cause === null || !("reason" in cause)) {
    return fallback;
  }
  const reason: unknown = cause.reason;
  return typeof reason === "string" && allowed.has(reason) ? reason : fallback;
};

const toolResult = <Value extends Readonly<Record<string, unknown>>>(
  structuredContent: Value,
) => ({
  content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
  structuredContent,
});

// #ignore-sloppy-code-next-line[async-keyword]: Standard Schema validation is Promise-capable, and MCP request callbacks consume its result through the SDK's native Promise contract.
const decodeToolInput = async <Value>(
  schema: StandardSchemaV1<unknown, Value>,
  value: unknown,
  toolName: string,
  // #ignore-sloppy-code-next-line[promise-type]: MCP request callbacks await Standard Schema validation through the SDK's native Promise contract.
): Promise<Value> => {
  const decoded = await schema["~standard"].validate(value);
  if (!("value" in decoded)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid arguments for tool ${toolName}`,
    );
  }
  return decoded.value;
};

// #ignore-sloppy-code-next-line[async-keyword]: MCP tool handlers are Promise callbacks, so this edge awaits Effect before returning the SDK result.
const runOperation = async <Value extends Readonly<Record<string, unknown>>>(
  options: RunOperationOptions<Value>,
) => {
  let outcome: Either.Either<Value, ClosedOperationError>;
  try {
    outcome = await Effect.runPromise(Effect.either(options.operation), {
      signal: options.signal,
    });
    // #ignore-sloppy-code-next-line[bare-catch]: The MCP boundary maps interruption and defects to a closed ProtocolError without exposing their causes over JSON-RPC.
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `${options.label} failed`,
      { reason: options.fallbackReason },
    );
  }
  if (Either.isLeft(outcome)) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `${options.label} failed`,
      {
        reason: operationReason(
          outcome.left,
          options.allowedReasons,
          options.fallbackReason,
        ),
      },
    );
  }
  return toolResult(outcome.right);
};

const runVoidOperation = (
  input: Omit<RunOperationOptions<HarnessEmptyResult>, "operation"> & {
    readonly operation: Effect.Effect<void, ClosedOperationError>;
  },
) =>
  runOperation({
    ...input,
    operation: input.operation.pipe(Effect.as({})),
  });

// #ignore-sloppy-code-next-line[async-keyword]: Standard Schema output validation is Promise-capable and runs inside the MCP SDK's Promise callback contract.
const validateToolOutput = async <
  Value,
  Result extends Readonly<{ structuredContent: Value }>,
>(
  schema: StandardSchemaV1<unknown, Value>,
  result: Result,
  toolName: string,
  // #ignore-sloppy-code-next-line[promise-type]: MCP request callbacks await Standard Schema output validation through the SDK's native Promise contract.
): Promise<Result> => {
  const decoded = await schema["~standard"].validate(result.structuredContent);
  if (!("value" in decoded)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid result from tool ${toolName}`,
    );
  }
  return result;
};

// #ignore-sloppy-code-next-line[async-keyword]: The MCP SDK callback must await both the Promise-native operation bridge and output validation before returning.
const runValidatedOperation = async <
  Value extends Readonly<Record<string, unknown>>,
>(
  schema: StandardSchemaV1<unknown, Value>,
  toolName: string,
  options: RunOperationOptions<Value>,
) => validateToolOutput(schema, await runOperation(options), toolName);

// #ignore-sloppy-code-next-line[async-keyword]: The MCP SDK callback must await the Promise-native void operation bridge before validating its result.
const runValidatedVoidOperation = async (
  toolName: string,
  input: Omit<RunOperationOptions<HarnessEmptyResult>, "operation"> & {
    readonly operation: Effect.Effect<void, ClosedOperationError>;
  },
) => validateToolOutput(emptyOutput, await runVoidOperation(input), toolName);

const registerStatusTool = (
  server: McpServer,
  operations: HarnessMcpOperations,
): void => {
  server.registerTool(
    STATUS_TOOL,
    { inputSchema: emptyInput, outputSchema: statusOutput },
    (input, context) => {
      if (Object.keys(input).length !== 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "Status accepts no arguments",
        );
      }
      return runOperation({
        operation: operations.readStatus(),
        label: "Status",
        allowedReasons: STATUS_REASONS,
        fallbackReason: "persistence",
        signal: context.mcpReq.signal,
      });
    },
  );
};

const registerRegistrationTool = (
  server: McpServer,
  operations: HarnessMcpOperations,
  state: ActiveCatalogState,
): void => {
  server.registerTool(
    REGISTER_TOOL,
    { inputSchema: registerInput, outputSchema: registerOutput },
    // #ignore-sloppy-code-next-line[async-keyword]: registerTool requires a Promise callback so catalog activation follows the completed registration result.
    async (input, context) => {
      const result = await runOperation({
        operation: operations.register(input),
        label: "Registration",
        allowedReasons: REGISTER_REASONS,
        fallbackReason: "upstream",
        signal: context.mcpReq.signal,
      });
      if (result.structuredContent.kind === "registered") {
        state.active = true;
      }
      return result;
    },
  );
};

const registerReadTools = (
  server: McpServer,
  operations: HarnessMcpOperations,
): void => {
  server.registerTool(
    SEARCH_AGENTS_TOOL,
    { inputSchema: searchAgentsInput, outputSchema: searchAgentsOutput },
    (input, context) =>
      runOperation({
        operation: operations.searchAgents(input),
        label: "Agent search",
        allowedReasons: SEARCH_AGENTS_REASONS,
        fallbackReason: "upstream",
        signal: context.mcpReq.signal,
      }),
  );
  server.registerTool(
    SEARCH_CONVERSATIONS_TOOL,
    {
      inputSchema: searchConversationsInput,
      outputSchema: searchConversationsOutput,
    },
    (input, context) =>
      runOperation({
        operation: operations.searchConversations(input),
        label: "Conversation search",
        allowedReasons: SEARCH_CONVERSATIONS_REASONS,
        fallbackReason: "persistence",
        signal: context.mcpReq.signal,
      }),
  );
  server.registerTool(
    READ_CONVERSATION_TOOL,
    {
      inputSchema: readConversationInput,
      outputSchema: readConversationOutput,
    },
    (input, context) =>
      runOperation({
        operation: operations.readConversation(input),
        label: "Conversation read",
        allowedReasons: READ_CONVERSATION_REASONS,
        fallbackReason: "representation",
        signal: context.mcpReq.signal,
      }),
  );
};

const decodeReplyGrant = (
  metadata: unknown,
): Effect.Effect<ReplyGrant, ProtocolError> =>
  decodeHarnessReplyRequestMeta(metadata).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(
        new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "Invalid reply authority",
          { reason: "authority-unavailable" },
        ),
      ),
    ),
  );

const registerModelTools = (
  server: McpServer,
  operations: HarnessMcpOperations,
): void => {
  server.registerTool(
    HARNESS_START_TOOL,
    { inputSchema: startInput, outputSchema: emptyOutput },
    (input, context) =>
      runVoidOperation({
        operation: operations.start(input),
        label: "Conversation start",
        allowedReasons: START_REASONS,
        fallbackReason: "representation",
        signal: context.mcpReq.signal,
      }),
  );
  server.registerTool(
    HARNESS_REPLY_TOOL,
    { inputSchema: replyInput, outputSchema: emptyOutput },
    // #ignore-sloppy-code-next-line[async-keyword]: registerTool requires a Promise callback to decode reply authority before invoking the reply operation.
    async (input, context) => {
      const grant = await Effect.runPromise(
        decodeReplyGrant(context.mcpReq._meta),
        { signal: context.mcpReq.signal },
      );
      return await runVoidOperation({
        operation: operations.reply(grant, input.content),
        label: "Reply",
        allowedReasons: REPLY_REASONS,
        fallbackReason: "authority-unavailable",
        signal: context.mcpReq.signal,
      });
    },
  );
};

const registerActiveTools = (
  server: McpServer,
  operations: HarnessMcpOperations,
): void => {
  registerReadTools(server, operations);
  registerModelTools(server, operations);
};

/**
 * Keep schema and operation failures on the JSON-RPC error channel.
 *
 * The high-level SDK tool dispatcher intentionally converts every thrown tool
 * callback error into an `isError` result. This boundary instead uses the
 * official low-level `tools/call` handler so malformed input and accepted
 * domain failures retain their distinct protocol codes and closed data.
 */
const installToolCallHandler = (
  server: McpServer,
  operations: HarnessMcpOperations,
  state: ActiveCatalogState,
): void => {
  // #ignore-sloppy-code-next-line[async-keyword]: setRequestHandler requires a Promise callback to sequence SDK input decoding, operations, and output validation.
  server.server.setRequestHandler("tools/call", async (request, context) => {
    const name = request.params.name;
    const arguments_ = request.params.arguments ?? {};

    if (name === STATUS_TOOL) {
      const input = await decodeToolInput(emptyInput, arguments_, name);
      if (Object.keys(input).length !== 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "Status accepts no arguments",
        );
      }
      return runValidatedOperation(statusOutput, name, {
        operation: operations.readStatus(),
        label: "Status",
        allowedReasons: STATUS_REASONS,
        fallbackReason: "persistence",
        signal: context.mcpReq.signal,
      });
    }

    if (!state.active) {
      if (name !== REGISTER_TOOL) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Tool ${name} not found`,
        );
      }
      const input = await decodeToolInput(registerInput, arguments_, name);
      const result = await runValidatedOperation(registerOutput, name, {
        operation: operations.register(input),
        label: "Registration",
        allowedReasons: REGISTER_REASONS,
        fallbackReason: "upstream",
        signal: context.mcpReq.signal,
      });
      if (result.structuredContent.kind === "registered") {
        state.active = true;
      }
      return result;
    }

    switch (name) {
      case SEARCH_AGENTS_TOOL:
        return runValidatedOperation(searchAgentsOutput, name, {
          operation: operations.searchAgents(
            await decodeToolInput(searchAgentsInput, arguments_, name),
          ),
          label: "Agent search",
          allowedReasons: SEARCH_AGENTS_REASONS,
          fallbackReason: "upstream",
          signal: context.mcpReq.signal,
        });
      case SEARCH_CONVERSATIONS_TOOL:
        return runValidatedOperation(searchConversationsOutput, name, {
          operation: operations.searchConversations(
            await decodeToolInput(searchConversationsInput, arguments_, name),
          ),
          label: "Conversation search",
          allowedReasons: SEARCH_CONVERSATIONS_REASONS,
          fallbackReason: "persistence",
          signal: context.mcpReq.signal,
        });
      case READ_CONVERSATION_TOOL:
        return runValidatedOperation(readConversationOutput, name, {
          operation: operations.readConversation(
            await decodeToolInput(readConversationInput, arguments_, name),
          ),
          label: "Conversation read",
          allowedReasons: READ_CONVERSATION_REASONS,
          fallbackReason: "representation",
          signal: context.mcpReq.signal,
        });
      case HARNESS_START_TOOL:
        return runValidatedVoidOperation(name, {
          operation: operations.start(
            await decodeToolInput(startInput, arguments_, name),
          ),
          label: "Conversation start",
          allowedReasons: START_REASONS,
          fallbackReason: "representation",
          signal: context.mcpReq.signal,
        });
      case HARNESS_REPLY_TOOL: {
        const input = await decodeToolInput(replyInput, arguments_, name);
        const grant = await Effect.runPromise(
          decodeReplyGrant(context.mcpReq._meta),
          { signal: context.mcpReq.signal },
        );
        return runValidatedVoidOperation(name, {
          operation: operations.reply(grant, input.content),
          label: "Reply",
          allowedReasons: REPLY_REASONS,
          fallbackReason: "authority-unavailable",
          signal: context.mcpReq.signal,
        });
      }
      default:
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Tool ${name} not found`,
        );
    }
  });
};

const makeServer = (
  options: HarnessMcpHandlerOptions,
  state: ActiveCatalogState,
): McpServer => {
  const registrySignerPublicKey = Schema.encodeSync(Ed25519PublicKey)(
    options.registrySignerPublicKey,
  );
  const server = new McpServer(options.implementation, {
    capabilities: {
      extensions: {
        [HARNESS_EVENTS_EXTENSION]: {
          registrySignerPublicKey,
        },
      },
    },
  });
  registerStatusTool(server, options.operations);
  if (state.active) {
    registerActiveTools(server, options.operations);
  } else {
    registerRegistrationTool(server, options.operations, state);
  }
  installToolCallHandler(server, options.operations, state);
  return server;
};

/**
 * Create one state-dependent official MCP handler and custom turn listener.
 * @param options Closed daemon operations and deployment identity material.
 * @returns Handler whose catalog transitions in place after registration.
 */
export const makeHarnessMcpHttpHandler = (
  options: HarnessMcpHandlerOptions,
): Effect.Effect<
  HarnessMcpSubscriptionHandler<HarnessTurnEvent>,
  ClosedOperationError
> =>
  options.operations.readStatus().pipe(
    Effect.map((status) => {
      const state: ActiveCatalogState = { active: status.kind === "active" };
      const delegate = createMcpHandler(() => makeServer(options, state), {
        legacy: "reject",
        responseMode: "json",
        onerror: options.onerror,
      });
      return makeHarnessMcpSubscriptionHandler({
        delegate,
        implementation: options.implementation,
        onActiveChange: options.onSubscriptionActiveChange,
        onerror: options.onerror,
      });
    }),
  );

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults after the MCP boundary. */
