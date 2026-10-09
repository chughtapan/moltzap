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
  type StandardSchemaWithJSON,
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
  decodeHarnessSendResult,
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
  sendErrorData,
} from "../../delivery/operations.js";
import {
  authenticateHarnessRequest,
  type HarnessMcpCredentials,
  type HarnessMcpRole,
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
  HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
  HARNESS_READ_EVENT_TOOL,
  HARNESS_READ_INBOX_TOOL,
  HARNESS_READ_SEND_TOOL,
  HARNESS_SEND_TOOL,
} from "./names.js";
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
  /**
   * Whether the daemon's protocol is up. The catalog lists the
   * post-registration tools, and admits their calls and the inbox
   * subscription, only while it is.
   */
  readonly protocolActive: () => boolean;
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
 * Run one send and answer its typed failure as JSON-RPC error data. A send
 * that ends without one, interrupted or by a defect, may already have queued
 * its post, so it answers `outcome-unknown`.
 * @param operation A multicast, collective send or collective response.
 * @param signal The request's abort signal, which interrupts the send.
 * @returns The send's tool result.
 */
// #ignore-sloppy-code-next-line[async-keyword]: MCP tool handlers are Promise callbacks, so this edge awaits Effect before returning the SDK result.
const runSendOperation = async (
  operation: Effect.Effect<HarnessSendResult, SendError | CollectiveError>,
  signal: AbortSignal,
) => {
  const outcome = await Effect.runPromiseExit(operation, { signal });
  if (Exit.isFailure(outcome)) {
    const data = Option.match(Cause.failureOption(outcome.cause), {
      onNone: (): HarnessSendErrorData => ({ reason: "outcome-unknown" }),
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

/** A tool's catalog entry: its description and schemas. */
interface ToolListing {
  readonly description?: string;
  readonly inputSchema: StandardSchemaWithJSON;
  readonly outputSchema?: StandardSchemaWithJSON;
}

/**
 * Every tool the catalog can list. `installToolCallHandler` replaces the
 * SDK's tools/call dispatch, so `toolHandlers` serves every call and a listing
 * only names a tool and its schemas.
 */
const toolListings = {
  [STATUS_TOOL]: { inputSchema: emptyInput, outputSchema: statusOutput },
  [REGISTER_TOOL]: { inputSchema: registerInput, outputSchema: registerOutput },
  event_subscription_status: {
    description:
      "Inspect the runtime consumer and stalled delivery without exposing callback credentials.",
    inputSchema: emptyInput,
    outputSchema: makeStandardSchema(webhookStatusJsonSchema),
  },
  revoke_event_subscription: {
    description:
      "Release the active runtime consumer. Pending inbox items remain unread.",
    inputSchema: emptyInput,
  },
  resume_event_subscription: {
    description:
      "Resume transient callback retries. Terminal rejection requires revocation and reconfiguration.",
    inputSchema: emptyInput,
  },
  [SEARCH_AGENTS_TOOL]: {
    inputSchema: searchAgentsInput,
    outputSchema: searchAgentsOutput,
  },
  [SEARCH_CONVERSATIONS_TOOL]: {
    inputSchema: searchConversationsInput,
    outputSchema: searchConversationsOutput,
  },
  [READ_CONVERSATION_TOOL]: {
    inputSchema: readConversationInput,
    outputSchema: readConversationOutput,
  },
  [HARNESS_READ_INBOX_TOOL]: {
    inputSchema: readInboxInput,
    outputSchema: readInboxOutput,
  },
  [HARNESS_READ_SEND_TOOL]: {
    inputSchema: readSendInput,
    outputSchema: readSendOutput,
  },
  [HARNESS_SEND_TOOL]: { inputSchema: sendInput, outputSchema: sendOutput },
  [HARNESS_READ_EVENT_TOOL]: {
    description:
      "Read the original full content of a MoltZap event by eventId. This read has no delivery or acknowledgment side effects.",
    inputSchema: readEventInput,
    outputSchema: readEventOutput,
  },
  [HARNESS_ACKNOWLEDGE_DELIVERY_TOOL]: {
    inputSchema: acknowledgeDeliveryInput,
    outputSchema: emptyOutput,
  },
} as const satisfies Readonly<Record<string, ToolListing>>;

type ToolName = keyof typeof toolListings;

interface RoleCatalog {
  readonly inactive: readonly ToolName[];
  readonly active: readonly ToolName[];
}

const ownerEventTools = [
  "event_subscription_status",
  "revoke_event_subscription",
  "resume_event_subscription",
] as const;

/** The local and owner tools that follow registration, after `status`. */
const activeTools = [
  SEARCH_AGENTS_TOOL,
  SEARCH_CONVERSATIONS_TOOL,
  READ_CONVERSATION_TOOL,
  HARNESS_READ_INBOX_TOOL,
  HARNESS_READ_SEND_TOOL,
  HARNESS_SEND_TOOL,
  HARNESS_READ_EVENT_TOOL,
  HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
] as const;

/**
 * The tools each role lists before the daemon's protocol is up and once it
 * is. The runtime role lists nothing until then.
 */
const roleCatalogs = {
  local: {
    inactive: [STATUS_TOOL, REGISTER_TOOL],
    active: [STATUS_TOOL, ...activeTools],
  },
  owner: {
    inactive: [STATUS_TOOL, ...ownerEventTools, REGISTER_TOOL],
    active: [STATUS_TOOL, ...ownerEventTools, ...activeTools],
  },
  runtime: {
    inactive: [],
    active: [SEARCH_AGENTS_TOOL, HARNESS_SEND_TOOL, HARNESS_READ_EVENT_TOOL],
  },
} as const satisfies Readonly<Record<HarnessMcpRole, RoleCatalog>>;

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
    fallbackReason: "incompatible-daemon",
    signal: input.signal,
  });
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
const handleRegistrationToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeToolInput(
    registerInput,
    input.toolArguments,
    input.name,
  );
  return await runValidatedOperation(registerOutput, input.name, {
    operation: operations.register(decoded),
    label: "Registration",
    allowedReasons: REGISTER_REASONS,
    fallbackReason: "dependency-unavailable",
    signal: input.signal,
  });
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

/**
 * Run one send call. A send that returns a result outside its output schema
 * has already run, so that result is a defect, which `runSendOperation`
 * answers as `outcome-unknown`.
 * @param input The `send_message` arguments, metadata and abort signal.
 * @param operations The daemon operations that run the send.
 * @returns The send's validated tool result.
 */
// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
const handleSendToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeInvocationInput(
    decodeHarnessSendCall(input.toolArguments, input.metadata),
    input.signal,
  );
  const send = operations
    .send(decoded)
    .pipe(
      Effect.flatMap((result) =>
        decodeHarnessSendResult(result).pipe(Effect.orDie),
      ),
    );
  return await validateToolOutput(
    sendOutput,
    await runSendOperation(send, input.signal),
    input.name,
  );
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
  return await runValidatedOperation(emptyOutput, input.name, {
    operation: operations
      .acknowledgeDelivery(decoded.deliveryToken)
      .pipe(Effect.as<HarnessEmptyResult>({})),
    label: "Delivery acknowledgment",
    allowedReasons: ACKNOWLEDGE_DELIVERY_REASONS,
    fallbackReason: "transport-failed",
    signal: input.signal,
  });
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
const handleReadEventToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) =>
  await runValidatedOperation(readEventOutput, input.name, {
    operation: operations.readEvent(
      await decodeToolInput(readEventInput, input.toolArguments, input.name),
    ),
    label: "Event read",
    allowedReasons: RUNTIME_READ_REASONS,
    fallbackReason: "persistence-failed",
    signal: input.signal,
  });

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits schema validation and the Promise-native operation bridge.
const handleReadInboxToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) =>
  await runValidatedOperation(readInboxOutput, input.name, {
    operation: operations.readInbox(
      await decodeToolInput(readInboxInput, input.toolArguments, input.name),
    ),
    label: "Inbox read",
    allowedReasons: RUNTIME_READ_REASONS,
    fallbackReason: "persistence-failed",
    signal: input.signal,
  });

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP request handler awaits argument decoding and the Promise-native operation bridge.
const handleReadSendToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) =>
  await runValidatedOperation(readSendOutput, input.name, {
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

/** The operations a tool call runs: the daemon's and the event subscription's. */
interface ToolOperations extends HarnessMcpOperations {
  readonly events: HarnessEvents;
}

// #ignore-sloppy-code-next-line[async-keyword]: The MCP edge validates its Promise-native tool schema before running the owner operation.
const handleOwnerOperation = async (
  operation: Effect.Effect<Readonly<Record<string, unknown>>, ProtocolError>,
  input: ToolCallInput,
) => {
  await decodeToolInput(emptyInput, input.toolArguments, input.name);
  return toolResult(await runEventOperation(operation, input.signal));
};

/** Serves one admitted call of the tool it is keyed by in `toolHandlers`. */
type ToolHandler = (
  input: ToolCallInput,
  operations: ToolOperations,
  // eslint-disable-next-line agent-code-guard/promise-type -- MCP tool handlers are Promise callbacks of the official SDK.
) => Promise<ReturnType<typeof toolResult>>;

/**
 * The handler for each tool the catalog can list, keyed like `toolListings`,
 * so a listed tool without a handler does not compile.
 */
const toolHandlers = {
  [STATUS_TOOL]: handleStatusToolCall,
  [REGISTER_TOOL]: handleRegistrationToolCall,
  event_subscription_status: (input, operations) =>
    handleOwnerOperation(operations.events.status, input),
  revoke_event_subscription: (input, operations) =>
    handleOwnerOperation(operations.events.revoke.pipe(Effect.as({})), input),
  resume_event_subscription: (input, operations) =>
    handleOwnerOperation(operations.events.resume.pipe(Effect.as({})), input),
  [SEARCH_AGENTS_TOOL]: handleSearchAgentsToolCall,
  [SEARCH_CONVERSATIONS_TOOL]: handleSearchConversationsToolCall,
  [READ_CONVERSATION_TOOL]: handleReadConversationToolCall,
  [HARNESS_READ_INBOX_TOOL]: handleReadInboxToolCall,
  [HARNESS_READ_SEND_TOOL]: handleReadSendToolCall,
  [HARNESS_SEND_TOOL]: handleSendToolCall,
  [HARNESS_READ_EVENT_TOOL]: handleReadEventToolCall,
  [HARNESS_ACKNOWLEDGE_DELIVERY_TOOL]: handleAcknowledgeDeliveryToolCall,
} satisfies Readonly<Record<ToolName, ToolHandler>>;

/**
 * The tools `role` lists and may call now: its catalog for whether the
 * daemon's protocol is up. Listing and admission read this one answer.
 * @param role The request's authority.
 * @param operations The daemon operations that report the protocol state.
 * @returns The tool names, in catalog order.
 */
const currentTools = (
  role: HarnessMcpRole,
  operations: HarnessMcpOperations,
): readonly ToolName[] => {
  const catalog = roleCatalogs[role];
  return operations.protocolActive() ? catalog.active : catalog.inactive;
};

// #ignore-sloppy-code-next-line[async-keyword]: The low-level MCP dispatcher awaits the selected Promise-native tool handler.
const handleToolCall = async (
  input: ToolCallInput,
  operations: ToolOperations,
  role: HarnessMcpRole,
) => {
  const name = currentTools(role, operations).find(
    (tool) => tool === input.name,
  );
  if (name === undefined) {
    return toolNotFound(input.name);
  }
  return await toolHandlers[name](input, operations);
};

/** Schema failures and refused operations stay on the JSON-RPC error channel. */
const installToolCallHandler = (
  server: McpServer,
  operations: ToolOperations,
  role: HarnessMcpRole,
): void => {
  server.server.setRequestHandler("tools/call", (request, context) => {
    const input = {
      name: request.params.name,
      toolArguments: request.params.arguments ?? {},
      metadata: context.mcpReq._meta,
      signal: context.mcpReq.signal,
    };
    return handleToolCall(input, operations, role);
  });
};
const runtimeOperations = (
  operations: HarnessMcpOperations,
  events: HarnessEvents,
): ToolOperations => ({
  ...operations,
  events,
  acknowledgeDelivery: (token) =>
    operations
      .acknowledgeDelivery(token)
      .pipe(Effect.tap(() => Effect.sync(() => events.notifyPending()))),
});
/**
 * One request's server. Its catalog is the role's, read from the daemon's
 * protocol state when the request arrives.
 */
const makeServer = (
  options: HarnessMcpHandlerOptions,
  events: HarnessEvents,
  role: HarnessMcpRole,
): McpServer => {
  const capabilities = { tools: {}, events: {} };
  const server = new McpServer(options.implementation, { capabilities });
  for (const name of currentTools(role, options.operations)) {
    const listing: ToolListing = toolListings[name];
    server.registerTool(name, listing, () => toolResult({}));
  }
  installToolCallHandler(
    server,
    runtimeOperations(options.operations, events),
    role,
  );
  events.install(server.server, role === "local" ? undefined : role);
  return server;
};
const officialHandler = (
  options: HarnessMcpHandlerOptions,
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
      return makeServer(options, events, role);
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
  scope: Scope.CloseableScope,
) =>
  Effect.gen(function* () {
    const gate = yield* Effect.makeSemaphore(1);
    const webhook = yield* acquireWebhook(options, scope, gate);
    const events = yield* makeHarnessEvents({
      ...(webhook === undefined ? {} : { webhook }),
      summary: options.operations.readInboxSummary,
      protocolActive: options.operations.protocolActive,
      gate,
      keepAliveMillis: options.keepAliveMillis,
      onActiveChange: options.onSubscriptionActiveChange,
    });
    return guardedHandler(
      options,
      officialHandler(options, events),
      events,
      scope,
    );
  });

/**
 * Create one official MCP handler with explicit event resource ownership.
 * @param options Daemon operations, optional credentials and callback persistence.
 * @returns Handler whose catalog follows the daemon's protocol state.
 */
export const makeHarnessMcpHttpHandler = (
  options: HarnessMcpHandlerOptions,
): Effect.Effect<HarnessMcpEventHandler, ClosedOperationError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    return yield* acquireHandler(options, scope).pipe(
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  }).pipe(Effect.withSpan("makeHarnessMcpHttpHandler"));

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults after the MCP boundary. */
