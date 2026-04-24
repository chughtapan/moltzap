/**
 * types — public types for @moltzap/claude-code-channel.
 *
 * Principle 2: the values that cross the channel boundary have declared
 * shapes. Principle 3: error channels are typed unions, not thrown strings.
 * Principle 4: every union discriminates on `_tag`.
 *
 * Interfaces only. No function bodies beyond `throw new Error("not implemented")`.
 */

import type { Effect } from "effect";
import type { EnrichedInboundMessage, WsClientLogger } from "@moltzap/client";
import type {
  AllowlistError,
  BootError,
  PushError,
} from "./errors.js";

/**
 * Branded chat id — corresponds to MoltZap's `conversationId` on the wire,
 * rendered to Claude Code as the contract-meta key `chat_id`.
 * Principle 1: preventing accidental confusion with `MessageId` at call sites.
 */
export type ChatId = string & { readonly __brand: "ChatId" };

/**
 * Branded message id — corresponds to MoltZap's `id`, rendered as
 * contract-meta `message_id`.
 */
export type MessageId = string & { readonly __brand: "MessageId" };

/**
 * Branded user id — corresponds to MoltZap's `sender.id`, rendered as
 * contract-meta `user`.
 */
export type UserId = string & { readonly __brand: "UserId" };

/**
 * ISO-8601 timestamp — corresponds to MoltZap's `createdAt` (already ISO),
 * rendered as contract-meta `ts`.
 */
export type IsoTimestamp = string & { readonly __brand: "IsoTimestamp" };

/**
 * Claude Code channel notification shape.
 *
 * The meta keys are FIXED by Anthropic's channel contract (fakechat
 * reference, server.ts:135-148). Divergence breaks the `<channel>` tag
 * renderer inside Claude Code.
 */
export interface ClaudeChannelNotification {
  readonly method: "notifications/claude/channel";
  readonly params: {
    readonly content: string;
    readonly meta: {
      readonly chat_id: ChatId;
      readonly message_id: MessageId;
      readonly user: UserId;
      readonly ts: IsoTimestamp;
      readonly file_path?: string;
    };
  };
}

/**
 * `gateInbound` hook — zapbot-parity allowlist seam.
 *
 * Must be pure and synchronous (spec I5). Returning a failure drops the
 * event; no downstream notification is emitted. No I/O, no mutation.
 */
export type GateInbound = (
  event: EnrichedInboundMessage,
) =>
  | { readonly _tag: "Success"; readonly value: EnrichedInboundMessage }
  | { readonly _tag: "Failure"; readonly error: AllowlistError };

/**
 * Boot options — one struct per caller.
 *
 * No `Record<string, unknown>`, no `any`. Logger is the same shape the rest
 * of `@moltzap/client` uses.
 */
export interface BootOptions {
  readonly serverUrl: string;
  readonly agentKey: string;
  readonly logger: WsClientLogger;
  readonly gateInbound?: GateInbound;
  /**
   * Override the MCP server's advertised name. Defaults to
   * `"@moltzap/claude-code-channel"`.
   */
  readonly serverName?: string;
  /**
   * Override the MCP server's `instructions` string delivered at handshake.
   * Defaults to a contract-conformant default describing the `<channel>` tag
   * shape and the `reply` tool.
   */
  readonly instructions?: string;
}

/**
 * Lifecycle handle returned by `bootClaudeCodeChannel`.
 *
 * Principle 3: every operation has a typed error channel. `push` uses
 * `Effect<void, PushError>` so the MCP emit failure surfaces as a tag, not a
 * rejected Promise. `stop` is infallible-by-design (teardown swallows
 * downstream errors into logs per spec I8).
 */
export interface Handle {
  readonly push: (
    notification: ClaudeChannelNotification,
  ) => Effect.Effect<void, PushError>;
  readonly stop: () => Effect.Effect<void>;
}

export type { AllowlistError, BootError, PushError } from "./errors.js";
