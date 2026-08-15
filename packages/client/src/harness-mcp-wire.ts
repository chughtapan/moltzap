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
import { Cause, Effect, Exit, Option, Schema } from "effect";
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
) => {
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
  const outcome = await Effect.runPromiseExit(options.operation, {
    signal: options.signal,
  });
  if (Exit.isFailure(outcome)) {
    const expectedFailure = Option.match(Cause.dieOption(outcome.cause), {
      onNone: () => Cause.failureOption(outcome.cause),
      onSome: () => Option.none(),
    });
    const reason = Option.match(expectedFailure, {
      onNone: () => options.fallbackReason,
      onSome: (failure) =>
        operationReason(
          failure,
          options.allowedReasons,
          options.fallbackReason,
        ),
    });
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `${options.label} failed`,
      {
        reason,
      },
    );
  }
  return toolResult(outcome.value);
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
) => {
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
) => await validateToolOutput(schema, await runOperation(options), toolName);

// #ignore-sloppy-code-next-line[async-keyword]: The MCP SDK callback must await the Promise-native void operation bridge before validating its result.
const runValidatedVoidOperation = async (
  toolName: string,
  input: Omit<RunOperationOptions<HarnessEmptyResult>, "operation"> & {
    readonly operation: Effect.Effect<void, ClosedOperationError>;
  },
) =>
  await validateToolOutput(
    emptyOutput,
    await runVoidOperation(input),
    toolName,
  );

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

interface ToolCallInput {
  readonly name: string;
  readonly toolArguments: unknown;
  readonly metadata: unknown;
  readonly signal: AbortSignal;
}

const toolNotFound = (name: string): never => {
  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Tool ${name} not found`,
  );
};

const activateCatalog = (state: ActiveCatalogState): void => {
  state.active = true;
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native Effect bridge.
const handleStatusToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeToolInput(
    emptyInput,
    input.toolArguments,
    input.name,
  );
  if (Object.keys(decoded).length !== 0) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "Status accepts no arguments",
    );
  }
  return await runValidatedOperation(statusOutput, input.name, {
    operation: operations.readStatus(),
    label: "Status",
    allowedReasons: STATUS_REASONS,
    fallbackReason: "persistence",
    signal: input.signal,
  });
};

// #ignore-sloppy-code-next-line[async-keyword]: Catalog activation follows the completed Promise-native registration bridge.
const handleRegistrationToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
  state: ActiveCatalogState,
) => {
  const decoded = await decodeToolInput(
    registerInput,
    input.toolArguments,
    input.name,
  );
  const result = await runValidatedOperation(registerOutput, input.name, {
    operation: operations.register(decoded),
    label: "Registration",
    allowedReasons: REGISTER_REASONS,
    fallbackReason: "upstream",
    signal: input.signal,
  });
  if (result.structuredContent.kind === "registered") {
    activateCatalog(state);
  }
  return result;
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
const handleSearchAgentsToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeToolInput(
    searchAgentsInput,
    input.toolArguments,
    input.name,
  );
  return await runValidatedOperation(searchAgentsOutput, input.name, {
    operation: operations.searchAgents(decoded),
    label: "Agent search",
    allowedReasons: SEARCH_AGENTS_REASONS,
    fallbackReason: "upstream",
    signal: input.signal,
  });
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
const handleSearchConversationsToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeToolInput(
    searchConversationsInput,
    input.toolArguments,
    input.name,
  );
  return await runValidatedOperation(searchConversationsOutput, input.name, {
    operation: operations.searchConversations(decoded),
    label: "Conversation search",
    allowedReasons: SEARCH_CONVERSATIONS_REASONS,
    fallbackReason: "persistence",
    signal: input.signal,
  });
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
const handleReadConversationToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeToolInput(
    readConversationInput,
    input.toolArguments,
    input.name,
  );
  return await runValidatedOperation(readConversationOutput, input.name, {
    operation: operations.readConversation(decoded),
    label: "Conversation read",
    allowedReasons: READ_CONVERSATION_REASONS,
    fallbackReason: "representation",
    signal: input.signal,
  });
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
const handleStartToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeToolInput(
    startInput,
    input.toolArguments,
    input.name,
  );
  return await runValidatedVoidOperation(input.name, {
    operation: operations.start(decoded),
    label: "Conversation start",
    allowedReasons: START_REASONS,
    fallbackReason: "representation",
    signal: input.signal,
  });
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation, reply authority decoding, and the Promise-native operation bridge.
const handleReplyToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeToolInput(
    replyInput,
    input.toolArguments,
    input.name,
  );
  const grant = await Effect.runPromise(decodeReplyGrant(input.metadata), {
    signal: input.signal,
  });
  return await runValidatedVoidOperation(input.name, {
    operation: operations.reply(grant, decoded.content),
    label: "Reply",
    allowedReasons: REPLY_REASONS,
    fallbackReason: "authority-unavailable",
    signal: input.signal,
  });
};

// #ignore-sloppy-code-next-line[async-keyword]: Active tool dispatch returns the selected Promise-native MCP operation result.
const handleActiveToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  switch (input.name) {
    case SEARCH_AGENTS_TOOL:
      return await handleSearchAgentsToolCall(input, operations);
    case SEARCH_CONVERSATIONS_TOOL:
      return await handleSearchConversationsToolCall(input, operations);
    case READ_CONVERSATION_TOOL:
      return await handleReadConversationToolCall(input, operations);
    case HARNESS_START_TOOL:
      return await handleStartToolCall(input, operations);
    case HARNESS_REPLY_TOOL:
      return await handleReplyToolCall(input, operations);
    default:
      return toolNotFound(input.name);
  }
};

// #ignore-sloppy-code-next-line[async-keyword]: Inactive dispatch admits only the Promise-native registration operation.
const handleInactiveToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
  state: ActiveCatalogState,
) => {
  if (input.name !== REGISTER_TOOL) {
    return toolNotFound(input.name);
  }
  return await handleRegistrationToolCall(input, operations, state);
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP dispatcher awaits the selected state-dependent Promise callback.
const handleToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
  state: ActiveCatalogState,
) => {
  if (input.name === STATUS_TOOL) {
    return await handleStatusToolCall(input, operations);
  }
  if (!state.active) {
    return await handleInactiveToolCall(input, operations, state);
  }
  return await handleActiveToolCall(input, operations);
};

/**
 * Keep schema and operation failures on the JSON-RPC error channel.
 *
 * The high-level SDK tool dispatcher intentionally converts every thrown tool
 * callback error into an `isError` result. This boundary instead uses the
 * official low-level `tools/call` handler so malformed input and accepted
 * domain failures retain their distinct protocol codes and closed data.
 * @param server Official MCP server that owns the low-level request handler.
 * @param operations Closed daemon operations exposed through the tool catalog.
 * @param state Shared registration state controlling active tool visibility.
 */
const installToolCallHandler = (
  server: McpServer,
  operations: HarnessMcpOperations,
  state: ActiveCatalogState,
): void => {
  server.server.setRequestHandler("tools/call", (request, context) =>
    handleToolCall(
      {
        name: request.params.name,
        toolArguments: request.params.arguments ?? {},
        metadata: context.mcpReq._meta,
        signal: context.mcpReq.signal,
      },
      operations,
      state,
    ),
  );
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
