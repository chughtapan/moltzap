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
import { Cause, Effect, Exit, JSONSchema, Option, Schema } from "effect";
import type { DeliveryToken } from "./endpoint/store.js";
import { type SendInput, SendInput as SendInputSchema } from "./contract.js";
import {
  HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
  HARNESS_EVENTS_EXTENSION,
  HARNESS_SEND_TOOL,
  type HarnessAcknowledgeDeliveryRequest,
  harnessAcknowledgeDeliveryRequestJsonSchema,
  type HarnessEmptyResult,
  harnessEmptyResultJsonSchema,
  type HarnessMessageReadyEvent,
} from "./harness-mcp-contract.js";
import {
  type HarnessMcpSubscriptionHandler,
  makeHarnessMcpSubscriptionHandler,
} from "./harness-mcp-subscription.js";
import {
  type ManagementReadConversationRequest,
  managementReadConversationRequestSchema,
  type ManagementReadConversationResult,
  managementReadConversationResultSchema,
  type ManagementRegisterRequest,
  managementRegisterRequestSchema,
  type ManagementRegisterResult,
  managementRegisterResultSchema,
  type ManagementSearchAgentsRequest,
  managementSearchAgentsRequestSchema,
  type ManagementSearchAgentsResult,
  managementSearchAgentsResultSchema,
  type ManagementSearchConversationsRequest,
  managementSearchConversationsRequestSchema,
  type ManagementSearchConversationsResult,
  managementSearchConversationsResultSchema,
  type ManagementStatusResult,
  managementStatusResultSchema,
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
  readonly send: (
    input: SendInput,
  ) => Effect.Effect<void, ClosedOperationError>;
  readonly acknowledgeDelivery: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<void, ClosedOperationError>;
}

interface HarnessMcpHandlerOptions {
  readonly implementation: Implementation;
  readonly operations: HarnessMcpOperations;
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

const makeJsonSchema = <A, I>(schema: Schema.Schema<A, I>) =>
  JSONSchema.make(schema, { target: "jsonSchema2020-12" });

const emptyRequestSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Never,
});
const registerInput = makeStandardSchema<ManagementRegisterRequest>(
  makeJsonSchema(managementRegisterRequestSchema),
);
const registerOutput = makeStandardSchema<ManagementRegisterResult>(
  makeJsonSchema(managementRegisterResultSchema),
);
const emptyInput = makeStandardSchema<Record<string, never>>(
  makeJsonSchema(emptyRequestSchema),
);
const statusOutput = makeStandardSchema<ManagementStatusResult>(
  makeJsonSchema(managementStatusResultSchema),
);
const searchAgentsInput = makeStandardSchema<ManagementSearchAgentsRequest>(
  makeJsonSchema(managementSearchAgentsRequestSchema),
);
const searchAgentsOutput = makeStandardSchema<ManagementSearchAgentsResult>(
  makeJsonSchema(managementSearchAgentsResultSchema),
);
const searchConversationsInput =
  makeStandardSchema<ManagementSearchConversationsRequest>(
    makeJsonSchema(managementSearchConversationsRequestSchema),
  );
const searchConversationsOutput =
  makeStandardSchema<ManagementSearchConversationsResult>(
    makeJsonSchema(managementSearchConversationsResultSchema),
  );
const readConversationInput =
  makeStandardSchema<ManagementReadConversationRequest>(
    makeJsonSchema(managementReadConversationRequestSchema),
  );
const readConversationOutput =
  makeStandardSchema<ManagementReadConversationResult>(
    makeJsonSchema(managementReadConversationResultSchema),
  );
const sendInput = makeStandardSchema<SendInput>(
  JSONSchema.make(SendInputSchema, { target: "jsonSchema2020-12" }),
);
const acknowledgeDeliveryInput =
  makeStandardSchema<HarnessAcknowledgeDeliveryRequest>(
    harnessAcknowledgeDeliveryRequestJsonSchema,
  );
const emptyOutput = makeStandardSchema<HarnessEmptyResult>(
  harnessEmptyResultJsonSchema,
);

const REGISTER_REASONS = new Set([
  "dependency-unavailable",
  "persistence-failed",
  "incompatible-daemon",
]);
const STATUS_REASONS = new Set(["persistence-failed", "incompatible-daemon"]);
const SEARCH_AGENTS_REASONS = new Set([
  "not-registered",
  "dependency-unavailable",
  "incompatible-daemon",
]);
const SEARCH_CONVERSATIONS_REASONS = new Set([
  "not-registered",
  "invalid-address",
  "persistence-failed",
]);
const READ_CONVERSATION_REASONS = new Set([
  "not-registered",
  "invalid-address",
  "unknown-agent",
  "invalid-continuation",
  "history-gap",
  "persistence-failed",
]);
const SEND_REASONS = new Set([
  "invalid-address",
  "unknown-agent",
  "membership-invalid",
  "content-invalid",
  "not-registered",
  "version-mismatch",
  "certification-unavailable",
  "persistence-failed",
  "network-unavailable",
]);
const ACKNOWLEDGE_DELIVERY_REASONS = new Set([
  "unknown-delivery",
  "delivery-conflict",
  "persistence-failed",
  "transport-failed",
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
        fallbackReason: "persistence-failed",
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
        fallbackReason: "dependency-unavailable",
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
        fallbackReason: "dependency-unavailable",
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
        fallbackReason: "persistence-failed",
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
        fallbackReason: "persistence-failed",
        signal: context.mcpReq.signal,
      }),
  );
};

const registerAdapterTools = (
  server: McpServer,
  operations: HarnessMcpOperations,
): void => {
  server.registerTool(
    HARNESS_SEND_TOOL,
    { inputSchema: sendInput, outputSchema: emptyOutput },
    (input, context) =>
      runVoidOperation({
        operation: operations.send(input),
        label: "Addressed send",
        allowedReasons: SEND_REASONS,
        fallbackReason: "network-unavailable",
        signal: context.mcpReq.signal,
      }),
  );
  server.registerTool(
    HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
    { inputSchema: acknowledgeDeliveryInput, outputSchema: emptyOutput },
    (input, context) =>
      runVoidOperation({
        operation: operations.acknowledgeDelivery(input.deliveryToken),
        label: "Delivery acknowledgment",
        allowedReasons: ACKNOWLEDGE_DELIVERY_REASONS,
        fallbackReason: "transport-failed",
        signal: context.mcpReq.signal,
      }),
  );
};

const registerActiveTools = (
  server: McpServer,
  operations: HarnessMcpOperations,
): void => {
  registerReadTools(server, operations);
  registerAdapterTools(server, operations);
};

interface ToolCallInput {
  readonly name: string;
  readonly toolArguments: unknown;
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
    fallbackReason: "persistence-failed",
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
    fallbackReason: "dependency-unavailable",
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
    fallbackReason: "dependency-unavailable",
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
    fallbackReason: "persistence-failed",
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
    fallbackReason: "persistence-failed",
    signal: input.signal,
  });
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
const handleSendToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeToolInput(
    sendInput,
    input.toolArguments,
    input.name,
  );
  return await runValidatedVoidOperation(input.name, {
    operation: operations.send(decoded),
    label: "Addressed send",
    allowedReasons: SEND_REASONS,
    fallbackReason: "network-unavailable",
    signal: input.signal,
  });
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
const handleAcknowledgeDeliveryToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeToolInput(
    acknowledgeDeliveryInput,
    input.toolArguments,
    input.name,
  );
  return await runValidatedVoidOperation(input.name, {
    operation: operations.acknowledgeDelivery(decoded.deliveryToken),
    label: "Delivery acknowledgment",
    allowedReasons: ACKNOWLEDGE_DELIVERY_REASONS,
    fallbackReason: "transport-failed",
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
    case HARNESS_SEND_TOOL:
      return await handleSendToolCall(input, operations);
    case HARNESS_ACKNOWLEDGE_DELIVERY_TOOL:
      return await handleAcknowledgeDeliveryToolCall(input, operations);
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
  const server = new McpServer(options.implementation, {
    capabilities: {
      experimental: {
        [HARNESS_EVENTS_EXTENSION]: {},
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
 * Create one state-dependent official MCP handler and message listener.
 * @param options Closed daemon operations and lifecycle callbacks.
 * @returns Handler whose catalog transitions in place after registration.
 */
export const makeHarnessMcpHttpHandler = (
  options: HarnessMcpHandlerOptions,
): Effect.Effect<
  HarnessMcpSubscriptionHandler<HarnessMessageReadyEvent>,
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
