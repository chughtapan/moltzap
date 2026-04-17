import type { Part } from "@moltzap/protocol";
import { Schema } from "effect";

export interface BeforeMessageDeliveryContext {
  conversationId: string;
  sender: { agentId: string; ownerId: string };
  message: { parts: Part[]; replyToId?: string };
  sessionId: string;
  appId: string;
  signal: AbortSignal;
}

export interface HookResult {
  block: boolean;
  reason?: string;
  patch?: { parts: Part[] };
  feedback?: {
    type: "error" | "warning" | "info";
    content: Record<string, unknown>;
    retry?: boolean;
  };
}

/**
 * Wire schema for `HookResult` — runs over webhook responses so malformed
 * payloads surface as `WebhookDecodeError` instead of leaking through an
 * unchecked cast. `parts` in `patch` is deliberately `Schema.Unknown` to
 * avoid importing the full `Part` protocol schema into the server-core
 * adapter layer; the runtime `Part` shape is re-validated at the
 * message-send boundary. The cast reconciles that intentional widening
 * with the `Part[]` field in `HookResult`.
 */
export const HookResultSchema = Schema.Struct({
  block: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  patch: Schema.optional(
    Schema.Struct({ parts: Schema.Array(Schema.Unknown) }),
  ),
  feedback: Schema.optional(
    Schema.Struct({
      type: Schema.Literal("error", "warning", "info"),
      content: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      retry: Schema.optional(Schema.Boolean),
    }),
  ),
}) as unknown as Schema.Schema<HookResult, unknown>;

/**
 * Schema for fire-and-forget hook webhooks (`on_join`, `on_close`,
 * `on_session_active`). Accepts an empty / undefined body from 204
 * responses; any payload is ignored.
 */
export const VoidHookSchema: Schema.Schema<void, unknown> = Schema.transform(
  Schema.Unknown,
  Schema.Void,
  { decode: () => undefined, encode: () => undefined },
);

export type BeforeMessageDeliveryHook = (
  ctx: BeforeMessageDeliveryContext,
) => HookResult | Promise<HookResult>;

export interface OnJoinContext {
  conversations: Record<string, string>;
  agent: { agentId: string; ownerId: string };
  sessionId: string;
  appId: string;
}

export type OnJoinHook = (ctx: OnJoinContext) => void | Promise<void>;

export interface OnCloseContext {
  sessionId: string;
  appId: string;
  conversations: Record<string, string>;
  closedBy: { agentId: string; ownerId: string };
  signal: AbortSignal;
}

export type OnCloseHook = (ctx: OnCloseContext) => void | Promise<void>;

export interface OnSessionActiveContext {
  sessionId: string;
  appId: string;
  conversations: Record<string, string>;
  admittedAgentIds: string[];
  signal: AbortSignal;
}

export type OnSessionActiveHook = (
  ctx: OnSessionActiveContext,
) => void | Promise<void>;

export interface AppHooks {
  beforeMessageDelivery?: BeforeMessageDeliveryHook;
  onJoin?: OnJoinHook;
  onClose?: OnCloseHook;
  onSessionActive?: OnSessionActiveHook;
}
