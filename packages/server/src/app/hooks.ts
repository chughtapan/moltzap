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
 * Typed `Part[]` schema. Server-core doesn't duplicate the canonical
 * `Part` schema (TypeBox, in @moltzap/protocol); we accept any array and
 * trust the message-send boundary to re-validate shape. `Schema.declare`
 * attaches the type witness via a runtime type-guard.
 */
const PartArraySchema = Schema.declare(
  (input: unknown): input is Part[] => Array.isArray(input),
  { identifier: "PartArray" },
);

/** Wire schema for `HookResult` webhook responses. Single-layer `as`
 *  reconciles effect-schema's encoded-type inference (which mirrors the
 *  Struct shape) with the caller's `Schema.Schema<_, unknown>` slot. */
export const HookResultSchema = Schema.Struct({
  block: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.Struct({ parts: PartArraySchema })),
  feedback: Schema.optional(
    Schema.Struct({
      type: Schema.Literal("error", "warning", "info"),
      content: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      retry: Schema.optional(Schema.Boolean),
    }),
  ),
}) as Schema.Schema<HookResult, unknown>;

/** Fire-and-forget hooks (`on_join`, `on_close`, `on_session_active`) — any payload is ignored. */
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
