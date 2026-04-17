import type { Part } from "@moltzap/protocol";

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
