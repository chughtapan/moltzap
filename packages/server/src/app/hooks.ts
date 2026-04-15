import type { Part } from "@moltzap/protocol";

// ── Hook Contexts ────────────────────────────────────────────────────

export interface BeforeMessageDeliveryContext {
  conversationId: string;
  senderId: string;
  parts: Part[];
  sessionId: string;
  appId: string;
}

export interface OnJoinContext {
  sessionId: string;
  appId: string;
  agentId: string;
  grantedResources: string[];
}

// ── Hook Results ─────────────────────────────────────────────────────

export type HookResult =
  | { action: "allow" }
  | { action: "block"; reason: string; feedback?: unknown; retry?: boolean }
  | { action: "patch"; parts: Part[] };

// ── Handler Types ────────────────────────────────────────────────────

export type BeforeMessageDeliveryHandler = (
  ctx: BeforeMessageDeliveryContext,
  signal: AbortSignal,
) => Promise<HookResult> | HookResult;

export type OnJoinHandler = (
  ctx: OnJoinContext,
  signal: AbortSignal,
) => Promise<void> | void;
