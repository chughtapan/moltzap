/**
 * server — MCP stdio server that fronts the Claude Code channel contract.
 *
 * Transplanted from zapbot `src/claude-channel/server.ts` (verdict §(b) MOVE
 * row 2). Adapted:
 *   - Capability declaration is FIXED to
 *       `{ tools: {}, experimental: { "claude/channel": {} } }`
 *     (spec I3, A14). Zapbot's conditional `enableReplyTool` / permission-
 *     relay branches are removed — reply is mandatory, permission-relay
 *     does not ship (non-goal §3.2, A6).
 *   - Tool set reduced to `reply` only (spec A4, A7). `send_direct_message`
 *     DELETED (non-goal §3.1). `edit_message` OMITTED in v1 (OQ4 default B;
 *     `~/moltzap/packages/protocol/` has no edit-message RPC as of
 *     commit 025ba58 — verified via `grep -rn "edit|update" packages/protocol/src`).
 *   - `reply` tool resolves target chat via `RoutingState` (OQ5). Tool's
 *     inputSchema is `{text, reply_to?, files?}` exactly per contract; NO
 *     `conversationId` required param.
 *
 * Reference: fakechat/server.ts:59-66 (capability), 67-92 (tool list),
 * 135-148 (notification shape).
 */

import { Effect } from "effect";
import type { WsClientLogger } from "@moltzap/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeChannelNotification, MessageId } from "./types.js";
import type { PushError, ReplyError } from "./errors.js";
import type { RoutingState } from "./routing.js";
import { stringifyCause } from "./utils.js";

const REPLY_TOOL_NAME = "reply";

/**
 * Dependencies the server receives from `entry.ts`. The server does not
 * instantiate `MoltZapChannelCore`; the entry module does, and injects the
 * narrow capabilities the server actually uses.
 *
 * `transportFactory` is optional and internal — defaulting to a real
 * `StdioServerTransport`. Tests inject an in-memory transport to exercise
 * handshake and tool-call behavior without spawning subprocesses.
 */
export interface ServerDeps {
  readonly sendReply: (
    chatId: string,
    text: string,
  ) => Effect.Effect<void, ReplyError>;
  readonly routing: RoutingState;
  readonly logger: WsClientLogger;
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

export type ServerBootError =
  | { readonly _tag: "StdioConnectFailed"; readonly cause: string }
  | { readonly _tag: "ToolRegistrationFailed"; readonly cause: string };

export type ServerBootResult =
  | { readonly _tag: "Ok"; readonly value: ServerHandle }
  | { readonly _tag: "Err"; readonly error: ServerBootError };

/**
 * Schema for the `reply` tool's inputSchema field. Matches contract verbatim
 * (fakechat/server.ts:75-86). Required: `text`. Optional: `reply_to`, `files`.
 */
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
// string[]`. `as const` on the literal above would narrow it to `readonly`
// and break assignment. `REPLY_TOOL_INPUT_SCHEMA_MUTABLE` is the handler
// copy; tests assert deep equality against the frozen literal.
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

export interface DecodedReplyArgs {
  readonly text: string;
  readonly replyTo?: MessageId;
  readonly files?: ReadonlyArray<string>;
}

export type ReplyArgsDecodeResult =
  | { readonly _tag: "Ok"; readonly value: DecodedReplyArgs }
  | {
      readonly _tag: "Err";
      readonly error: {
        readonly _tag: "ReplyArgsInvalid";
        readonly reason: string;
      };
    };

/**
 * Decode and validate a raw `reply` tool-call `arguments` object at the MCP
 * boundary (Principle 2). No `as` casts across this seam.
 */
export function decodeReplyArgs(raw: unknown): ReplyArgsDecodeResult {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return {
      _tag: "Err",
      error: {
        _tag: "ReplyArgsInvalid",
        reason: "arguments must be an object",
      },
    };
  }
  const obj = raw as Record<string, unknown>; // #ignore-sloppy-code[record-cast]: MCP boundary decode — raw is unknown; field-level typeof checks follow immediately

  if (typeof obj.text !== "string") {
    return {
      _tag: "Err",
      error: { _tag: "ReplyArgsInvalid", reason: "text must be a string" },
    };
  }
  const text = obj.text;
  if (text.trim().length === 0) {
    return {
      _tag: "Err",
      error: { _tag: "ReplyArgsInvalid", reason: "text must be non-empty" },
    };
  }

  let replyTo: MessageId | undefined;
  if (obj.reply_to !== undefined) {
    if (typeof obj.reply_to !== "string" || obj.reply_to.trim().length === 0) {
      return {
        _tag: "Err",
        error: {
          _tag: "ReplyArgsInvalid",
          reason: "reply_to must be a non-empty string",
        },
      };
    }
    replyTo = obj.reply_to as MessageId;
  }

  let files: ReadonlyArray<string> | undefined;
  if (obj.files !== undefined) {
    if (!Array.isArray(obj.files)) {
      return {
        _tag: "Err",
        error: { _tag: "ReplyArgsInvalid", reason: "files must be an array" },
      };
    }
    for (const f of obj.files) {
      if (typeof f !== "string") {
        return {
          _tag: "Err",
          error: {
            _tag: "ReplyArgsInvalid",
            reason: "files must be an array of strings",
          },
        };
      }
    }
    files = obj.files as ReadonlyArray<string>;
  }

  return {
    _tag: "Ok",
    value:
      files !== undefined
        ? { text, replyTo, files }
        : replyTo !== undefined
          ? { text, replyTo }
          : { text },
  };
}

function toolErrorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function toolOkResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

/**
 * Boot the Claude Code channel MCP stdio server.
 *
 * Advertises capabilities `{ tools: {}, experimental: { "claude/channel": {} } }`.
 * Registers exactly one tool: `reply`. No other notification methods, no
 * `send_direct_message`, no `edit_message`, no caller-injected tools.
 */
// #ignore-sloppy-code-next-line[async-keyword]: MCP SDK connect() is Promise-based; startup sequence wraps MCP SDK primitives
export async function bootChannelMcpServer(
  config: ServerConfig,
  deps: ServerDeps,
  // #ignore-sloppy-code-next-line[promise-type]: public API over MCP SDK — SDK requires Promise-returning function
): Promise<ServerBootResult> {
  const server = new Server(
    { name: config.serverName, version: "0.1.0" },
    {
      capabilities: CHANNEL_CAPABILITIES,
      instructions: config.instructions,
    },
  );

  // Pending-notification queue for pre-initialization push calls.
  let initialized = false;
  const pending: ClaudeChannelNotification[] = [];
  server.oninitialized = () => {
    initialized = true;
    // Best-effort flush; failures log and continue so one bad push doesn't
    // hide the rest from the client.
    // #ignore-sloppy-code-next-line[async-keyword]: IIFE needed to await server.notification inside a sync oninitialized callback
    void (async () => {
      while (pending.length > 0) {
        const n = pending.shift();
        if (n === undefined) break;
        try {
          await server.notification({
            method: n.method,
            params: n.params as unknown as Record<string, unknown>, // #ignore-sloppy-code[record-cast, as-unknown-as]: MCP SDK notification() requires Record<string,unknown>; our params is more specific
          });
        } catch (err) {
          deps.logger.error(
            { err },
            "claude-code-channel: queued notification emit failed",
          );
        }
      }
    })();
  };

  try {
    const toolList: ListToolsResult = {
      tools: [
        {
          name: REPLY_TOOL_NAME,
          description:
            "Send a message back through the MoltZap channel. Pass reply_to (a message_id from the channel) to target a specific conversation; omit to reply to the most recent inbound.",
          inputSchema: buildReplyInputSchema(),
        },
      ],
    };
    // #ignore-sloppy-code-next-line[async-keyword]: MCP SDK setRequestHandler callback type requires Promise return
    server.setRequestHandler(ListToolsRequestSchema, async () => toolList);

    // #ignore-sloppy-code-next-line[async-keyword]: MCP SDK setRequestHandler callback type requires Promise return
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== REPLY_TOOL_NAME) {
        return toolErrorResult(`unknown tool: ${request.params.name}`);
      }
      const decoded = decodeReplyArgs(request.params.arguments);
      if (decoded._tag === "Err") {
        return toolErrorResult(decoded.error.reason);
      }
      // v1 ships the contract-shaped `files` input (spec A4, fakechat parity),
      // but attachment upload is a v1.1 follow-up. Reject explicitly with a
      // tagged error rather than silently dropping the files (reviewer-187).
      if (decoded.value.files !== undefined && decoded.value.files.length > 0) {
        return toolErrorResult(
          `FilesUnsupported: reply.files is not supported in v1 (${decoded.value.files.length.toString()} file(s) rejected). Tracked as v1.1 follow-up.`,
        );
      }
      const resolution = deps.routing.resolveTarget(decoded.value.replyTo);
      switch (resolution._tag) {
        case "Resolved": {
          const sendResult = await Effect.runPromise(
            Effect.either(
              deps.sendReply(resolution.chatId, decoded.value.text),
            ),
          );
          if (sendResult._tag === "Left") {
            const e = sendResult.left;
            return toolErrorResult(
              e._tag === "SendFailed"
                ? `send failed: ${e.cause}`
                : `reply error: ${e._tag}`,
            );
          }
          return toolOkResult(`Reply sent to ${resolution.chatId as string}.`);
        }
        case "NoActiveChat":
          return toolErrorResult(
            "no active chat: no inbound message has been observed yet; pass reply_to after an inbound arrives",
          );
        case "ReplyToUnknown":
          return toolErrorResult(
            `reply_to does not match a known message_id: ${resolution.replyTo as string}`,
          );
        default: {
          // Principle 4: exhaustiveness. Reach here only if RoutingResolution adds a tag.
          const _exhaustive: never = resolution;
          return toolErrorResult(
            `unreachable routing: ${JSON.stringify(_exhaustive)}`,
          );
        }
      }
    });
  } catch (cause) {
    return {
      _tag: "Err",
      error: {
        _tag: "ToolRegistrationFailed",
        cause: stringifyCause(cause),
      },
    };
  }

  const transport = deps.transportFactory
    ? deps.transportFactory()
    : new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (cause) {
    return {
      _tag: "Err",
      error: { _tag: "StdioConnectFailed", cause: stringifyCause(cause) },
    };
  }

  const handle: ServerHandle = {
    push: (notification) =>
      Effect.gen(function* () {
        if (!initialized) {
          pending.push(notification);
          return;
        }
        yield* Effect.tryPromise({
          try: () =>
            server.notification({
              method: notification.method,
              params: notification.params as unknown as Record<string, unknown>, // #ignore-sloppy-code[record-cast, as-unknown-as]: MCP SDK notification() requires Record<string,unknown>; our params is more specific
            }),
          catch: (cause): PushError => ({
            _tag: "EmitFailed",
            cause: stringifyCause(cause),
          }),
        });
      }),
    stop: () =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => server.close(),
          catch: (cause): Error =>
            cause instanceof Error ? cause : new Error(stringifyCause(cause)),
        }).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              deps.logger.error(
                { err },
                "claude-code-channel: MCP close failed (swallowed per I8)",
              );
            }),
          ),
        );
      }),
  };

  return { _tag: "Ok", value: handle };
}
