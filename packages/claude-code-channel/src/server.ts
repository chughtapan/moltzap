/**
 * MCP stdio server fronting the Claude Code channel contract.
 *
 * Capabilities: `{ tools: {}, experimental: { "claude/channel": {} } }`.
 * Tools: `reply` only. `reply` resolves the target conversation via
 * `RoutingState`; inputSchema is `{ text, reply_to?, files? }`.
 */

import { Data, Effect, Either } from "effect";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeChannelNotification, MessageId } from "./types.js";
import { MessageId as makeMessageId } from "./types.js";
import {
  EmitFailed,
  LeaseAlreadyConsumed,
  SendFailed,
  type PushError,
  type ReplyError,
} from "./errors.js";
import type { RoutingState, RoutingTarget } from "./routing.js";
import { stringifyCause } from "./utils.js";

const REPLY_TOOL_NAME = "reply";

function isStringKeyedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMcpNotificationParams(
  params: ClaudeChannelNotification["params"],
): Record<string, unknown> {
  return {
    content: params.content,
    meta: params.meta,
  };
}

/**
 * Capabilities the server receives from `entry.ts`. `transportFactory` is an
 * internal test seam; production defaults to `new StdioServerTransport()`.
 */
export interface ServerDeps {
  readonly sendReply: (
    target: RoutingTarget,
    text: string,
  ) => Effect.Effect<void, ReplyError>;
  readonly routing: RoutingState;
  /** Internal test seam; production defaults to `new StdioServerTransport()`. */
  readonly transportFactory?: () => Transport;
}

export interface ServerConfig {
  readonly serverName: string;
  readonly instructions: string;
}

export interface ServerHandle {
  readonly push: (
    notification: ClaudeChannelNotification,
  ) => Effect.Effect<void, PushError>;
  readonly stop: () => Effect.Effect<void>;
}

class StdioConnectFailed extends Data.TaggedError("StdioConnectFailed")<{
  readonly cause: string;
}> {}

class ToolRegistrationFailed extends Data.TaggedError(
  "ToolRegistrationFailed",
)<{
  readonly cause: string;
}> {}

type ServerBootError = StdioConnectFailed | ToolRegistrationFailed;

export type ServerBootResult =
  | { readonly _tag: "Ok"; readonly value: ServerHandle }
  | { readonly _tag: "Err"; readonly error: ServerBootError };

interface PendingNotificationState {
  initialized: boolean;
  readonly pending: ClaudeChannelNotification[];
}

/** Schema for the `reply` tool's inputSchema field. Required: `text`. Optional: `reply_to`, `files`. */
export const REPLY_TOOL_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    text: { type: "string" as const },
    reply_to: { type: "string" as const },
    files: { type: "array" as const, items: { type: "string" as const } },
  },
  required: ["text"] as const,
};

/** Fixed MCP server capabilities. Misspelling breaks Claude Code rendering. */
export const CHANNEL_CAPABILITIES = {
  tools: {},
  experimental: { "claude/channel": {} },
} as const;

// The MCP SDK's ListTools `inputSchema` field wants a mutable `required:
// string[]`, so this builder returns a fresh mutable copy. The frozen
// `REPLY_TOOL_INPUT_SCHEMA` literal above is `readonly` and cannot satisfy
// that field directly; tests assert deep equality between the two.
function buildReplyInputSchema(): {
  type: "object";
  properties: {
    text: { type: "string" };
    reply_to: { type: "string" };
    files: { type: "array"; items: { type: "string" } };
  };
  required: string[];
} {
  return {
    type: "object",
    properties: {
      text: { type: "string" },
      reply_to: { type: "string" },
      files: { type: "array", items: { type: "string" } },
    },
    required: ["text"],
  };
}

interface DecodedReplyArgs {
  readonly text: string;
  readonly replyTo?: MessageId;
  readonly files?: ReadonlyArray<string>;
}

class ReplyArgsInvalid extends Data.TaggedError("ReplyArgsInvalid")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export type ReplyArgsDecodeResult = Either.Either<
  DecodedReplyArgs,
  ReplyArgsInvalid
>;

function invalidReplyArgs(reason: string): ReplyArgsInvalid {
  return new ReplyArgsInvalid({ reason });
}

function decodeReplyTo(
  raw: unknown,
): Either.Either<MessageId | undefined, ReplyArgsInvalid> {
  if (raw === undefined) return Either.right(undefined);
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return Either.left(invalidReplyArgs("reply_to must be a non-empty string"));
  }
  try {
    return Either.right(makeMessageId(raw));
  } catch (cause) {
    return Either.left(
      invalidReplyArgs(`reply_to must be a valid message_id: ${String(cause)}`),
    );
  }
}

function decodeReplyFiles(
  raw: unknown,
): Either.Either<ReadonlyArray<string> | undefined, ReplyArgsInvalid> {
  if (raw === undefined) return Either.right(undefined);
  if (!Array.isArray(raw)) {
    return Either.left(invalidReplyArgs("files must be an array"));
  }
  for (const file of raw) {
    if (typeof file !== "string") {
      return Either.left(invalidReplyArgs("files must be an array of strings"));
    }
  }
  return Either.right(raw as ReadonlyArray<string>);
}

function decodedReplyArgsValue(
  text: string,
  replyTo: MessageId | undefined,
  files: ReadonlyArray<string> | undefined,
): DecodedReplyArgs {
  if (files !== undefined) return { text, replyTo, files };
  if (replyTo !== undefined) return { text, replyTo };
  return { text };
}

export function decodeReplyArgs(raw: unknown): ReplyArgsDecodeResult {
  if (!isStringKeyedRecord(raw)) {
    return Either.left(invalidReplyArgs("arguments must be an object"));
  }
  const obj = raw;

  if (typeof obj.text !== "string") {
    return Either.left(invalidReplyArgs("text must be a string"));
  }
  const text = obj.text;
  if (text.trim().length === 0) {
    return Either.left(invalidReplyArgs("text must be non-empty"));
  }

  return Either.gen(function* () {
    const replyTo = yield* decodeReplyTo(obj.reply_to);
    const files = yield* decodeReplyFiles(obj.files);
    return decodedReplyArgsValue(text, replyTo, files);
  });
}

function toolErrorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function toolOkResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

function filesUnsupportedResult(fileCount: number): CallToolResult {
  return toolErrorResult(
    `FilesUnsupported: reply.files is not supported in v1 (${fileCount.toString()} file(s) rejected). Tracked as v1.1 follow-up.`,
  );
}

function sendFailureResult(error: ReplyError): CallToolResult {
  if (error instanceof LeaseAlreadyConsumed) {
    return toolErrorResult(
      `LeaseAlreadyConsumed: dispatch lease ${error.leaseId} was already consumed by an earlier reply in this dispatch turn.`,
    );
  }
  return toolErrorResult(
    error instanceof SendFailed
      ? `send failed: ${error.cause}`
      : `reply error: ${error.name}`,
  );
}

function sendResolvedReply(
  deps: ServerDeps,
  target: RoutingTarget,
  decoded: DecodedReplyArgs,
): Effect.Effect<CallToolResult> {
  return Effect.gen(function* () {
    const sendResult = yield* Effect.either(
      deps.sendReply(target, decoded.text),
    );
    return Either.match(sendResult, {
      onLeft: sendFailureResult,
      onRight: () => toolOkResult(`Reply sent to ${target.conversationId}.`),
    });
  });
}

function handleDecodedReplyCall(
  decoded: DecodedReplyArgs,
  deps: ServerDeps,
): Effect.Effect<CallToolResult> {
  if (decoded.files !== undefined && decoded.files.length > 0) {
    return Effect.succeed(filesUnsupportedResult(decoded.files.length));
  }

  const resolution = deps.routing.resolveTarget(decoded.replyTo);
  switch (resolution._tag) {
    case "Resolved":
      return sendResolvedReply(deps, resolution.target, decoded);
    case "NoActiveConversation":
      return Effect.succeed(
        toolErrorResult(
          "no active conversation: no inbound message has been observed yet; pass reply_to after an inbound arrives",
        ),
      );
    case "ReplyToUnknown":
      return Effect.succeed(
        toolErrorResult(
          `reply_to does not match a known message_id: ${resolution.replyTo as string}`,
        ),
      );
    default: {
      const _exhaustive: never = resolution;
      return Effect.succeed(
        toolErrorResult(`unreachable routing: ${JSON.stringify(_exhaustive)}`),
      );
    }
  }
}

/**
 * Claude → MoltZap outbound reply flow. Claude invokes the `reply`
 * MCP tool; the SDK deserializes the JSON-RPC call here.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant CC as Claude Code
 *   participant mcp as MCP SDK (stdio)
 *   participant srv as server.ts
 *   participant ent as entry.ts
 *   participant cli as moltzap-client
 *   CC->>mcp: tool call reply { text, reply_to? }
 *   mcp->>srv: CallToolRequest
 *   srv-->>mcp: name != reply → toolErrorResult
 *   srv->>srv: decodeReplyArgs (text non-empty)
 *   srv-->>mcp: ReplyArgsInvalid → toolErrorResult
 *   srv->>srv: decoded.files non-empty → filesUnsupportedResult
 *   srv->>srv: routing.resolveTarget(reply_to)
 *   srv-->>mcp: NoActiveConversation | ReplyToUnknown → toolErrorResult
 *   srv->>ent: deps.sendReply(conversationId, text)
 *   ent->>cli: messages/send with lease
 *   alt LeaseInvalid wire error
 *     cli-->>ent: LeaseAlreadyConsumed (via catchLeaseInvalid)
 *   end
 * ```
 *
 * File attachments are unsupported: a non-empty `files` array returns
 * `filesUnsupportedResult`. `LeaseAlreadyConsumed` is surfaced via the
 * host's `onLeaseConsumed` callback (channel-base contract); the tool
 * itself returns `toolErrorResult` so Claude's run continues.
 */
function handleCallToolRequest(
  request: CallToolRequest,
  deps: ServerDeps,
): Effect.Effect<CallToolResult> {
  if (request.params.name !== REPLY_TOOL_NAME) {
    return Effect.succeed(
      toolErrorResult(`unknown tool: ${request.params.name}`),
    );
  }

  return Either.match(decodeReplyArgs(request.params.arguments), {
    onLeft: (error) => Effect.succeed(toolErrorResult(error.reason)),
    onRight: (decoded) => handleDecodedReplyCall(decoded, deps),
  });
}

function emitMcpNotification(
  server: Server,
  notification: ClaudeChannelNotification,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () =>
      server.notification({
        method: notification.method,
        params: toMcpNotificationParams(notification.params),
      }),
    catch: (cause) => cause,
  });
}

function ignoreQueuedNotificationEmitFailure(
  err: unknown,
): Effect.Effect<void> {
  const message = "claude-code-channel: queued notification emit failed";
  return Effect.logError(message).pipe(
    Effect.annotateLogs({ err: stringifyCause(err) }),
  );
}

function flushPendingNotifications(
  server: Server,
  pending: ClaudeChannelNotification[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (pending.length > 0) {
      const notification = pending.shift();
      if (notification === undefined) break;
      yield* emitMcpNotification(server, notification).pipe(
        Effect.catchAll((err) => ignoreQueuedNotificationEmitFailure(err)),
      );
    }
  });
}

function emitPushNotification(
  server: Server,
  notification: ClaudeChannelNotification,
): Effect.Effect<void, PushError> {
  return Effect.tryPromise({
    try: () =>
      server.notification({
        method: notification.method,
        params: toMcpNotificationParams(notification.params),
      }),
    catch: (cause): PushError =>
      new EmitFailed({
        cause: stringifyCause(cause),
      }),
  });
}

function closeMcpServer(server: Server): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => server.close(),
    catch: (cause): Error =>
      cause instanceof Error ? cause : new Error(stringifyCause(cause)),
  }).pipe(Effect.catchAll((err) => logMcpCloseFailure(err)));
}

function makeMcpServer(config: ServerConfig): Server {
  return new Server(
    { name: config.serverName, version: "0.1.0" },
    {
      capabilities: CHANNEL_CAPABILITIES,
      instructions: config.instructions,
    },
  );
}

function buildToolList(): ListToolsResult {
  return {
    tools: [
      {
        name: REPLY_TOOL_NAME,
        description:
          "Send a message back through the MoltZap channel. Pass reply_to (a message_id from the channel) to target a specific conversation; omit to reply to the most recent inbound.",
        inputSchema: buildReplyInputSchema(),
      },
    ],
  };
}

function registerServerHandlers(
  server: Server,
  deps: ServerDeps,
): Effect.Effect<void, ToolRegistrationFailed> {
  return Effect.try({
    try: () => {
      const toolList = buildToolList();
      server.setRequestHandler(ListToolsRequestSchema, () =>
        Promise.resolve(toolList),
      );
      server.setRequestHandler(CallToolRequestSchema, (request) =>
        Effect.runPromise(handleCallToolRequest(request, deps)),
      );
    },
    catch: (cause) =>
      new ToolRegistrationFailed({ cause: stringifyCause(cause) }),
  });
}

function connectServer(
  server: Server,
  deps: ServerDeps,
): Effect.Effect<ServerBootResult | null> {
  const transport = deps.transportFactory
    ? deps.transportFactory()
    : new StdioServerTransport();
  return Effect.tryPromise({
    try: () => server.connect(transport),
    catch: (cause) => cause,
  }).pipe(
    Effect.match({
      onFailure: (cause): ServerBootResult => ({
        _tag: "Err",
        error: new StdioConnectFailed({
          cause: stringifyCause(cause),
        }),
      }),
      onSuccess: () => null,
    }),
  );
}

function markServerInitialized(
  server: Server,
  state: PendingNotificationState,
): void {
  state.initialized = true;
  Effect.runFork(flushPendingNotifications(server, state.pending));
}

function makeServerHandle(
  server: Server,
  state: PendingNotificationState,
): ServerHandle {
  return {
    push: (notification) =>
      Effect.gen(function* () {
        if (!state.initialized) {
          state.pending.push(notification);
          return;
        }
        yield* emitPushNotification(server, notification);
      }),
    stop: () => closeMcpServer(server),
  };
}

function logMcpCloseFailure(err: unknown): Effect.Effect<void> {
  const message = "claude-code-channel: MCP close failed (swallowed)";
  return Effect.logError(message).pipe(
    Effect.annotateLogs({ err: stringifyCause(err) }),
  );
}

/** Boot the Claude Code channel MCP stdio server. */
export function bootChannelMcpServer(config: ServerConfig, deps: ServerDeps) {
  return Effect.runPromise(bootChannelMcpServerEffect(config, deps));
}

function bootChannelMcpServerEffect(
  config: ServerConfig,
  deps: ServerDeps,
): Effect.Effect<ServerBootResult, never, never> {
  return Effect.gen(function* () {
    const server = makeMcpServer(config);
    const state: PendingNotificationState = { initialized: false, pending: [] };
    server.oninitialized = () => markServerInitialized(server, state);

    const registration = yield* Effect.either(
      registerServerHandlers(server, deps),
    );
    const registrationFailure = Either.match(registration, {
      onLeft: (error): ServerBootResult => ({ _tag: "Err", error }),
      onRight: () => null,
    });
    if (registrationFailure !== null) return registrationFailure;

    const connectFailure = yield* connectServer(server, deps);
    if (connectFailure !== null) return connectFailure;

    return { _tag: "Ok", value: makeServerHandle(server, state) };
  });
}
