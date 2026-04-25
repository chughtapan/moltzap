/**
 * errors — tagged error unions.
 *
 * Principle 3 (typed errors) + Principle 4 (exhaustiveness over optionality).
 *
 * OQ3 resolution: `BootError` minimum tag set is
 *   { ServiceConnectFailed, McpTransportFailed, AgentKeyInvalid }
 * — architect-extensible (spec OQ3 default B). Additional tags added here
 * must be handled exhaustively at every call site; there is no open-ended
 * `Other` tag.
 */

/**
 * Returned by `bootClaudeCodeChannel` when boot cannot proceed.
 */
export type BootError =
  | {
      readonly _tag: "ServiceConnectFailed";
      /** MoltZap WS `connect()` failed. */
      readonly cause: string;
    }
  | {
      readonly _tag: "McpTransportFailed";
      /** Stdio transport attach or MCP `server.connect` failed. */
      readonly cause: string;
    }
  | {
      readonly _tag: "AgentKeyInvalid";
      /** `agentKey` was missing, malformed, or rejected by the server. */
      readonly cause: string;
    }
  | {
      readonly _tag: "SchemaDecodeFailed";
      /** A WS or MCP boundary payload failed schema decode at boot. */
      readonly cause: string;
      /** The boundary that produced the decode failure. */
      readonly at: "ws" | "mcp";
    };

/**
 * Returned by `Handle.push` when the MCP notification cannot be emitted.
 */
export type PushError =
  | {
      readonly _tag: "EmitFailed";
      readonly cause: string;
    }
  | {
      readonly _tag: "NotConnected";
      /** Transport dropped between boot and this push. */
      readonly cause: string;
    };

/**
 * Returned by `gateInbound` when the inbound event fails consumer policy.
 *
 * The upstream package ships no allowlist set; zapbot (and any other
 * consumer) supplies the predicate. Tag set is intentionally minimal so the
 * consumer can map its own policy outcomes here without shape negotiation.
 */
export type AllowlistError =
  | {
      readonly _tag: "SenderNotAllowed";
      readonly senderId: string;
      readonly reason: string;
    }
  | {
      readonly _tag: "ConversationNotAllowed";
      readonly conversationId: string;
      readonly reason: string;
    };

/**
 * Returned by the `reply` tool handler when a call cannot be routed or sent.
 * Surfaces as an MCP tool error (isError: true) to Claude Code.
 *
 * `FilesUnsupported` is returned for `reply` calls that include a non-empty
 * `files` array. v1 ships contract-shaped decode for `files` (so Claude Code
 * can preview the argument surface) but does NOT ship attachment upload; a
 * v1.1 follow-up will wire `files` through the client attachments path. This
 * tagged error replaces the silent drop behavior reviewer-187 called out.
 */
export type ReplyError =
  | {
      readonly _tag: "NoActiveChat";
      /** `reply_to` was absent and no inbound has been observed yet. */
      readonly cause: string;
    }
  | {
      readonly _tag: "ReplyToUnknown";
      /** `reply_to` did not resolve to a known message_id. */
      readonly replyTo: string;
    }
  | {
      readonly _tag: "SendFailed";
      readonly cause: string;
    }
  | {
      readonly _tag: "FilesUnsupported";
      /** Count of files the caller tried to attach; for operator diagnostics. */
      readonly fileCount: number;
    };

/**
 * Returned by the `event.ts` translator when an inbound message cannot be
 * shaped into a contract-conformant notification.
 */
export type EventShapeError =
  | { readonly _tag: "ContentEmpty" }
  | { readonly _tag: "MetaInvalid"; readonly reason: string };
