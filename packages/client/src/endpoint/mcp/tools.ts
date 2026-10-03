/** @file Official MCP tool catalog and private Harness operation projection. */

import {
  createMcpHandler,
  fromJsonSchema,
  type Implementation,
  type JsonSchemaType,
  type McpHttpHandler,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type StandardSchemaV1,
} from "@modelcontextprotocol/server";
import {
  Cause,
  Effect,
  Exit,
  JSONSchema,
  Layer,
  Option,
  type ParseResult,
  Schema,
  Scope,
} from "effect";
import type { CollectiveError } from "../../transport/collectives/forms.js";
import type { SendError } from "../../transport/messaging/errors.js";
import {
  decodeHarnessReadSendRequest,
  type DeliveryOperations,
  type EventStore,
  type HarnessAcknowledgeDeliveryRequest,
  type HarnessReadInboxRequest,
  type HarnessReadInboxResult,
  type HarnessReadSendRequest,
  type HarnessReadSendResult,
  type HarnessSendArguments,
  type HarnessSendErrorData,
  type HarnessSendResult,
  readEventRequestSchema,
  readEventResultSchema,
} from "../../delivery/operations.js";
import {
  authenticateHarnessRequest,
  type HarnessMcpCredentials,
  type HarnessMcpRole,
  mayInvokeHarnessTool,
} from "./auth.js";
import {
  type HarnessEvents,
  makeHarnessEvents,
  makeWebhookEvents,
  runEventOperation,
  webhookHttpClientLayer,
  webhookStatusJsonSchema,
} from "./events.js";
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
} from "./owner-tools.js";
import {
  decodeHarnessSendCall,
  HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
  HARNESS_READ_EVENT_TOOL,
  HARNESS_READ_INBOX_TOOL,
  HARNESS_READ_SEND_TOOL,
  HARNESS_SEND_TOOL,
  harnessAcknowledgeDeliveryRequestJsonSchema,
  type HarnessEmptyResult,
  harnessEmptyResultJsonSchema,
  harnessFailureReasons,
  harnessReadInboxRequestJsonSchema,
  harnessReadInboxResultJsonSchema,
  harnessReadSendRequestJsonSchema,
  harnessReadSendResultJsonSchema,
  harnessSendArgumentsJsonSchema,
  harnessSendResultJsonSchema,
} from "./schemas.js";

/* eslint-disable agent-code-guard/async-keyword -- Official MCP factories and callbacks are Promise-native. */

const REGISTER_TOOL = "register";
const STATUS_TOOL = "status";
const SEARCH_AGENTS_TOOL = "search_agents";
const SEARCH_CONVERSATIONS_TOOL = "search_conversations";
const READ_CONVERSATION_TOOL = "read_conversation";

type ClosedOperationError = Readonly<{ readonly reason: string }>;

/** Structural daemon operations projected onto the loopback MCP boundary. */
export interface HarnessMcpOperations extends DeliveryOperations {
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
}

/** Official handler with one content-free daemon notification edge. */
export interface HarnessMcpEventHandler extends McpHttpHandler {
  readonly hasActiveSubscription: () => boolean;
  readonly notifyPending: () => boolean;
}

interface HarnessMcpHandlerOptions {
  readonly eventStore?: EventStore;
  readonly credentials?: HarnessMcpCredentials;
  readonly implementation: Implementation;
  readonly operations: HarnessMcpOperations;
  readonly onSubscriptionActiveChange?: (active: boolean) => void;
  readonly onerror?: (error: Error) => void;
  /** Idle keep-alive period of the message subscription; tests set it. */
  readonly keepAliveMillis?: number;
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
const sendInput = makeStandardSchema<HarnessSendArguments>(
  harnessSendArgumentsJsonSchema,
);
const acknowledgeDeliveryInput =
  makeStandardSchema<HarnessAcknowledgeDeliveryRequest>(
    harnessAcknowledgeDeliveryRequestJsonSchema,
  );
const emptyOutput = makeStandardSchema<HarnessEmptyResult>(
  harnessEmptyResultJsonSchema,
);
const sendOutput = makeStandardSchema<HarnessSendResult>(
  harnessSendResultJsonSchema,
);
const readEventInput = makeStandardSchema<typeof readEventRequestSchema.Type>(
  makeJsonSchema(readEventRequestSchema),
);
const readEventOutput = makeStandardSchema<typeof readEventResultSchema.Type>(
  makeJsonSchema(readEventResultSchema),
);
const readInboxInput = makeStandardSchema<HarnessReadInboxRequest>(
  harnessReadInboxRequestJsonSchema,
);
const readInboxOutput = makeStandardSchema<HarnessReadInboxResult>(
  harnessReadInboxResultJsonSchema,
);
const readSendInput = makeStandardSchema<HarnessReadSendRequest>(
  harnessReadSendRequestJsonSchema,
);
const readSendOutput = makeStandardSchema<HarnessReadSendResult>(
  harnessReadSendResultJsonSchema,
);
const {
  RUNTIME_READ_REASONS,
  REGISTER_REASONS,
  STATUS_REASONS,
  SEARCH_AGENTS_REASONS,
  SEARCH_CONVERSATIONS_REASONS,
  READ_CONVERSATION_REASONS,
  ACKNOWLEDGE_DELIVERY_REASONS,
} = harnessFailureReasons;

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

/**
 * The error data a refused send carries: a collective failure keeps its id
 * and the members or fields it names, so the loopback client rebuilds the
 * same typed error the daemon raised.
 */
const sendErrorData = (
  error: SendError | CollectiveError,
): HarnessSendErrorData => {
  switch (error._tag) {
    case "SendError":
      return { reason: error.reason };
    case "CollectiveError":
      return {
        reason: "collective-failed",
        id: error.id,
        failure: error.failure,
      };
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

// #ignore-sloppy-code-next-line[async-keyword]: MCP tool handlers are Promise callbacks, so this edge awaits Effect before returning the SDK result.
const runSendOperation = async (
  operation: Effect.Effect<HarnessSendResult, SendError | CollectiveError>,
  signal: AbortSignal,
) => {
  const outcome = await Effect.runPromiseExit(operation, { signal });
  if (Exit.isFailure(outcome)) {
    const data = Option.match(Cause.failureOption(outcome.cause), {
      onNone: (): HarnessSendErrorData => ({ reason: "network-unavailable" }),
      onSome: sendErrorData,
    });
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      "Operation send failed",
      data,
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

const registerSearchAgentsTool = (
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
};

const registerReadTools = (
  server: McpServer,
  operations: HarnessMcpOperations,
): void => {
  registerSearchAgentsTool(server, operations);
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

function registerSendTool(
  server: McpServer,
  operations: HarnessMcpOperations,
): void {
  server.registerTool(
    HARNESS_SEND_TOOL,
    { inputSchema: sendInput, outputSchema: sendOutput },
    (input, context) =>
      handleSendToolCall(
        {
          name: HARNESS_SEND_TOOL,
          toolArguments: input,
          metadata: context.mcpReq._meta,
          signal: context.mcpReq.signal,
        },
        operations,
      ),
  );
}

const registerEventReadTool = (
  server: McpServer,
  operations: HarnessMcpOperations,
): void => {
  server.registerTool(
    HARNESS_READ_EVENT_TOOL,
    {
      description:
        "Read the original full content of a MoltZap event by eventId. This read has no delivery or acknowledgment side effects.",
      inputSchema: readEventInput,
      outputSchema: readEventOutput,
    },
    (input, context) =>
      runOperation({
        operation: operations.readEvent(input),
        label: "Event read",
        allowedReasons: RUNTIME_READ_REASONS,
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
    HARNESS_READ_INBOX_TOOL,
    { inputSchema: readInboxInput, outputSchema: readInboxOutput },
    (input, context) =>
      runOperation({
        operation: operations.readInbox(input),
        label: "Inbox read",
        allowedReasons: RUNTIME_READ_REASONS,
        fallbackReason: "persistence-failed",
        signal: context.mcpReq.signal,
      }),
  );
  server.registerTool(
    HARNESS_READ_SEND_TOOL,
    { inputSchema: readSendInput, outputSchema: readSendOutput },
    (input, context) =>
      runOperation({
        operation: operations.readSend(input),
        label: "Send lookup",
        allowedReasons: RUNTIME_READ_REASONS,
        fallbackReason: "persistence-failed",
        signal: context.mcpReq.signal,
      }),
  );
  registerSendTool(server, operations);
  registerEventReadTool(server, operations);
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
  role: HarnessMcpRole,
): void => {
  if (role === "runtime") {
    registerSearchAgentsTool(server, operations);
    registerSendTool(server, operations);
    registerEventReadTool(server, operations);
    return;
  }
  registerReadTools(server, operations);
  registerAdapterTools(server, operations);
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

const decodeInvocationInput = <A>(
  input: Effect.Effect<A, ParseResult.ParseError>,
  signal: AbortSignal,
) =>
  runEventOperation(
    input.pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(
          new ProtocolError(-32602, "Invalid invocation arguments", {
            reason: "content-invalid",
          }),
        ),
      ),
    ),
    signal,
  );

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
async function handleSendToolCall(
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) {
  const decoded = await decodeInvocationInput(
    decodeHarnessSendCall(input.toolArguments, input.metadata),
    input.signal,
  );
  return await validateToolOutput(
    sendOutput,
    await runSendOperation(operations.send(decoded), input.signal),
    input.name,
  );
}

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

// #ignore-sloppy-code-next-line[async-keyword]: Runtime read dispatch validates the selected MCP schema before invoking the operation.
const handleInboxReadToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  switch (input.name) {
    case HARNESS_READ_EVENT_TOOL:
      return await runValidatedOperation(readEventOutput, input.name, {
        operation: operations.readEvent(
          await decodeToolInput(
            readEventInput,
            input.toolArguments,
            input.name,
          ),
        ),
        label: "Event read",
        allowedReasons: RUNTIME_READ_REASONS,
        fallbackReason: "persistence-failed",
        signal: input.signal,
      });
    case HARNESS_READ_INBOX_TOOL:
      return await runValidatedOperation(readInboxOutput, input.name, {
        operation: operations.readInbox(
          await decodeToolInput(
            readInboxInput,
            input.toolArguments,
            input.name,
          ),
        ),
        label: "Inbox read",
        allowedReasons: RUNTIME_READ_REASONS,
        fallbackReason: "persistence-failed",
        signal: input.signal,
      });
    default:
      return toolNotFound(input.name);
  }
};

// #ignore-sloppy-code-next-line[async-keyword]: Active tool dispatch returns the selected Promise-native MCP operation result.
const handleActiveToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  if ([HARNESS_READ_EVENT_TOOL, HARNESS_READ_INBOX_TOOL].includes(input.name)) {
    return await handleInboxReadToolCall(input, operations);
  }
  switch (input.name) {
    case HARNESS_READ_SEND_TOOL:
      return await runValidatedOperation(readSendOutput, input.name, {
        operation: operations.readSend(
          await decodeInvocationInput(
            decodeHarnessReadSendRequest(input.toolArguments),
            input.signal,
          ),
        ),
        label: "Send lookup",
        allowedReasons: RUNTIME_READ_REASONS,
        fallbackReason: "persistence-failed",
        signal: input.signal,
      });
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
  role: HarnessMcpRole,
) => {
  if (!mayInvokeHarnessTool(role, input.name)) {
    return toolNotFound(input.name);
  }
  if (input.name === STATUS_TOOL) {
    return await handleStatusToolCall(input, operations);
  }
  if (!state.active) {
    return await handleInactiveToolCall(input, operations, state);
  }
  return await handleActiveToolCall(input, operations);
};

const ownerEventDescriptions = {
  event_subscription_status:
    "Inspect the runtime consumer and stalled delivery without exposing callback credentials.",
  revoke_event_subscription:
    "Release the active runtime consumer. Pending inbox items remain unread.",
  resume_event_subscription:
    "Resume transient callback retries. Terminal rejection requires revocation and reconfiguration.",
};
const ownerEventTools = [
  "event_subscription_status",
  "revoke_event_subscription",
  "resume_event_subscription",
] as const;
const ownerEventOperation = (events: HarnessEvents, name: string) => {
  switch (name) {
    case "event_subscription_status":
      return events.status;
    case "revoke_event_subscription":
      return events.revoke.pipe(Effect.as({}));
    case "resume_event_subscription":
      return events.resume.pipe(Effect.as({}));
    default:
      return undefined;
  }
};
interface RequestAuthority {
  readonly role: HarnessMcpRole;
  readonly events: HarnessEvents;
}

// #ignore-sloppy-code-next-line[async-keyword]: The MCP edge validates its Promise-native tool schema before running the owner operation.
const handleOwnerOperation = async (
  operation: NonNullable<ReturnType<typeof ownerEventOperation>>,
  input: ToolCallInput,
) => {
  await decodeToolInput(emptyInput, input.toolArguments, input.name);
  return toolResult(await runEventOperation(operation, input.signal));
};

/** Schema failures and refused operations stay on the JSON-RPC error channel. */
const installToolCallHandler = (
  server: McpServer,
  operations: HarnessMcpOperations,
  state: ActiveCatalogState,
  authority: RequestAuthority,
): void => {
  server.server.setRequestHandler("tools/call", (request, context) => {
    const input = {
      name: request.params.name,
      toolArguments: request.params.arguments ?? {},
      metadata: context.mcpReq._meta,
      signal: context.mcpReq.signal,
    };
    const ownerOperation = ownerEventOperation(authority.events, input.name);
    if (authority.role === "owner" && ownerOperation !== undefined) {
      return handleOwnerOperation(ownerOperation, input);
    }
    return handleToolCall(input, operations, state, authority.role);
  });
};
const registerOwnerEvents = (server: McpServer) => {
  for (const name of ownerEventTools) {
    server.registerTool(
      name,
      {
        description: ownerEventDescriptions[name],
        inputSchema: emptyInput,
        ...(name === "event_subscription_status"
          ? { outputSchema: makeStandardSchema(webhookStatusJsonSchema) }
          : {}),
      },
      () => toolResult({}),
    );
  }
};
const runtimeOperations = (
  operations: HarnessMcpOperations,
  events: HarnessEvents,
): HarnessMcpOperations => ({
  ...operations,
  acknowledgeDelivery: (token) =>
    operations
      .acknowledgeDelivery(token)
      .pipe(Effect.tap(() => Effect.sync(() => events.notifyPending()))),
});
const makeServer = (
  options: HarnessMcpHandlerOptions,
  state: ActiveCatalogState,
  events: HarnessEvents,
  role: HarnessMcpRole,
): McpServer => {
  const capabilities = { tools: {}, events: {} };
  const server = new McpServer(options.implementation, { capabilities });
  if (role !== "runtime") {
    registerStatusTool(server, options.operations);
  }
  if (role === "owner") {
    registerOwnerEvents(server);
  }
  if (state.active) {
    registerActiveTools(server, options.operations, role);
  } else if (role !== "runtime") {
    registerRegistrationTool(server, options.operations, state);
  }
  installToolCallHandler(
    server,
    runtimeOperations(options.operations, events),
    state,
    { role, events },
  );
  events.install(server.server, role === "local" ? undefined : role);
  return server;
};
const officialHandler = (
  options: HarnessMcpHandlerOptions,
  state: ActiveCatalogState,
  events: HarnessEvents,
) =>
  createMcpHandler(
    (context) => {
      const request = context.requestInfo;
      if (request === undefined) {
        throw new ProtocolError(-32012, "Authentication required");
      }
      const role = authenticateHarnessRequest(request, options.credentials);
      if (role === undefined) {
        throw new ProtocolError(-32012, "Authentication required");
      }
      return makeServer(options, state, events, role);
    },
    { legacy: "reject", responseMode: "auto", onerror: options.onerror },
  );
const guardedHandler = (
  options: HarnessMcpHandlerOptions,
  delegate: McpHttpHandler,
  events: HarnessEvents,
  scope: Scope.CloseableScope,
): HarnessMcpEventHandler => ({
  ...delegate,
  hasActiveSubscription: events.hasActiveSubscription,
  notifyPending: events.notifyPending,
  fetch: (request, requestOptions) =>
    authenticateHarnessRequest(request, options.credentials) === undefined
      ? Promise.resolve(
          new Response("Unauthorized", {
            status: 401,
            headers: { "www-authenticate": "Bearer" },
          }),
        )
      : delegate.fetch(request, requestOptions),
  close: () =>
    Effect.runPromise(
      events.close.pipe(
        Effect.ensuring(
          Effect.tryPromise(() => delegate.close()).pipe(Effect.ignore),
        ),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      ),
    ),
});
const acquireWebhook = (
  options: HarnessMcpHandlerOptions,
  scope: Scope.CloseableScope,
  gate: Effect.Semaphore,
) =>
  Effect.gen(function* () {
    if (options.credentials === undefined || options.eventStore === undefined) {
      return undefined;
    }
    const context = yield* Layer.buildWithScope(webhookHttpClientLayer, scope);
    return yield* makeWebhookEvents(options.eventStore, gate).pipe(
      Effect.provide(context),
      Effect.mapError(() => ({ reason: "persistence-failed" })),
    );
  });
const acquireHandler = (
  options: HarnessMcpHandlerOptions,
  state: ActiveCatalogState,
  scope: Scope.CloseableScope,
) =>
  Effect.gen(function* () {
    const gate = yield* Effect.makeSemaphore(1);
    const webhook = yield* acquireWebhook(options, scope, gate);
    const events = yield* makeHarnessEvents({
      ...(webhook === undefined ? {} : { webhook }),
      summary: options.operations.readInboxSummary,
      registered: () => state.active,
      gate,
      keepAliveMillis: options.keepAliveMillis,
      onActiveChange: options.onSubscriptionActiveChange,
    });
    return guardedHandler(
      options,
      officialHandler(options, state, events),
      events,
      scope,
    );
  });

/**
 * Create one official MCP handler with explicit event resource ownership.
 * @param options Daemon operations, optional credentials and callback persistence.
 * @returns Handler whose catalog changes in place after registration.
 */
export const makeHarnessMcpHttpHandler = (
  options: HarnessMcpHandlerOptions,
): Effect.Effect<HarnessMcpEventHandler, ClosedOperationError> =>
  Effect.gen(function* () {
    const status = yield* options.operations.readStatus();
    const scope = yield* Scope.make();
    return yield* acquireHandler(
      options,
      { active: status.kind === "active" },
      scope,
    ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  }).pipe(Effect.withSpan("makeHarnessMcpHttpHandler"));

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults after the MCP boundary. */
