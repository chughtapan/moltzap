/**
 * types — public types for `@moltzap/claude-code-channel`.
 *
 * Principle 2: the values that cross the channel boundary have declared
 * shapes. Principle 3: error channels are typed unions, not thrown strings.
 * Principle 4: every union discriminates on `_tag`.
 *
 * Public interfaces and branded boundary values only.
 */

import type { Brand, Effect } from "effect";
import type { EnrichedInboundMessage, WsClientLogger } from "@moltzap/client";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import type { AgentId as ProtocolAgentId } from "@moltzap/protocol/identity";
import type {
  ConversationId as ProtocolConversationId,
  MessageId as ProtocolMessageId,
} from "@moltzap/protocol/task";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AllowlistError, PushError } from "./errors.js";

/**
 * Branded conversation id — corresponds to MoltZap's `conversationId` on the
 * wire, rendered to Claude Code as the contract-meta key `chat_id`.
 * Principle 1: preventing accidental confusion with `MessageId` at call sites.
 */
export type ConversationId = ProtocolConversationId;
export const ConversationId = conversationId;

/**
 * Branded message id — corresponds to MoltZap's `id`, rendered as
 * contract-meta `message_id`.
 */
export type MessageId = ProtocolMessageId;
export const MessageId = messageId;

/**
 * Branded user id — corresponds to MoltZap's `sender.id`, rendered as
 * contract-meta `user`.
 */
export type UserId = ProtocolAgentId;
export const UserId = agentId;

/**
 * ISO-8601 timestamp — corresponds to MoltZap's `createdAt` (already ISO),
 * rendered as contract-meta `ts`.
 */
export type IsoTimestamp = string & Brand.Brand<"IsoTimestamp">;

/**
 * Claude Code channel notification shape.
 *
 * The meta keys are FIXED by Anthropic's channel contract (fakechat
 * reference, server.ts:135-148). Divergence breaks the `&lt;channel&gt;` tag
 * renderer inside Claude Code.
 */
export interface ClaudeChannelNotification {
  readonly method: "notifications/claude/channel";
  readonly params: {
    readonly content: string;
    readonly meta: {
      readonly chat_id: ConversationId;
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
 * No `Record&lt;string, unknown&gt;`, no `any`. Logger is the same shape the rest
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
   * Defaults to a contract-conformant default describing the `&lt;channel&gt;` tag
   * shape and the `reply` tool.
   */
  readonly instructions?: string;
  /**
   * Internal test seam. When present, replaces the default
   * `StdioServerTransport` with an injected `Transport` (e.g.
   * `InMemoryTransport`) so integration tests can drive the real
   * `bootClaudeCodeChannel` boot path end-to-end without a subprocess.
   *
   * Field is prefixed `_` and explicitly tagged "tests-only" because no
   * production caller has reason to override the transport — production
   * always uses stdio. Reviewer #256: keep this seam narrow.
   */
  readonly _testTransportFactory?: () => Transport;
}

/**
 * Lifecycle handle returned by `bootClaudeCodeChannel`.
 *
 * Principle 3: every operation has a typed error channel. `push` uses
 * `Effect&lt;void, PushError&gt;` so the MCP emit failure surfaces as a tag, not a
 * rejected Promise. `stop` is infallible-by-design (teardown swallows
 * downstream errors into logs per spec I8).
 */
export interface Handle {
  readonly push: (
    notification: ClaudeChannelNotification,
  ) => Effect.Effect<void, PushError>;
  readonly stop: () => Effect.Effect<void>;
}
