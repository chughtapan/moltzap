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
 *
 * Stubs only.
 */

import type { Effect } from "effect";
import type { WsClientLogger } from "@moltzap/client";
import type {
  ClaudeChannelNotification,
  MessageId,
} from "./types.js";
import type { PushError, ReplyError } from "./errors.js";
import type { RoutingState } from "./routing.js";

/**
 * Dependencies the server receives from `entry.ts`. The server does not
 * instantiate `MoltZapChannelCore`; the entry module does, and injects the
 * narrow capabilities the server actually uses.
 */
export interface ServerDeps {
  /**
   * Bound delivery callback. Given resolved chat_id and text, sends via
   * `MoltZapChannelCore.sendReply`. Error surfaces as `ReplyError.SendFailed`.
   */
  readonly sendReply: (
    chatId: string,
    text: string,
  ) => Effect.Effect<void, ReplyError>;
  readonly routing: RoutingState;
  readonly logger: WsClientLogger;
}

export interface ServerConfig {
  readonly serverName: string;
  readonly instructions: string;
}

export interface ServerHandle {
  /** Push a `notifications/claude/channel` notification over stdio. */
  readonly push: (
    notification: ClaudeChannelNotification,
  ) => Effect.Effect<void, PushError>;

  /**
   * Shut down MCP transport. Infallible by design — teardown failures log
   * and swallow per spec I8.
   */
  readonly stop: () => Effect.Effect<void>;
}

export type ServerBootError =
  | { readonly _tag: "StdioConnectFailed"; readonly cause: string }
  | { readonly _tag: "ToolRegistrationFailed"; readonly cause: string };

export type ServerBootResult =
  | { readonly _tag: "Ok"; readonly value: ServerHandle }
  | { readonly _tag: "Err"; readonly error: ServerBootError };

/**
 * Boot the Claude Code channel MCP stdio server.
 *
 * Advertises the fixed capability declaration:
 *   `{ tools: {}, experimental: { "claude/channel": {} } }`
 *
 * Registers exactly one tool: `reply`.
 *
 * Does NOT:
 *   - emit any notification method other than `notifications/claude/channel`
 *     (spec A6);
 *   - register `send_direct_message` (spec A7, non-goal §3.1);
 *   - register `edit_message` in v1 (OQ4 default B);
 *   - accept a caller-injected tool list (spec A4 "no caller-injected tool
 *     definitions").
 */
export function bootChannelMcpServer(
  config: ServerConfig,
  deps: ServerDeps,
): Promise<ServerBootResult> {
  throw new Error("not implemented");
}

/**
 * Schema for the `reply` tool's inputSchema field. Exported so the server
 * and unit tests can share a single source. Matches contract verbatim
 * (fakechat/server.ts:75-86). Required: `text`. Optional: `reply_to`,
 * `files`.
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

/**
 * Decoded shape of an inbound `reply` tool call's arguments. Validated at
 * the MCP boundary (Principle 2).
 */
export interface DecodedReplyArgs {
  readonly text: string;
  readonly replyTo?: MessageId;
  readonly files?: ReadonlyArray<string>;
}

export type ReplyArgsDecodeResult =
  | { readonly _tag: "Ok"; readonly value: DecodedReplyArgs }
  | {
      readonly _tag: "Err";
      readonly error: { readonly _tag: "ReplyArgsInvalid"; readonly reason: string };
    };

/**
 * Decode and validate a raw `reply` tool-call `arguments` object.
 * Called inside the MCP `CallToolRequestSchema` handler.
 */
export function decodeReplyArgs(raw: unknown): ReplyArgsDecodeResult {
  throw new Error("not implemented");
}
