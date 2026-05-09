/**
 * Per-conversation cancellation wiring for the claude-code-channel plugin.
 *
 * Architect-281 §3 — module `claude-code-cancel-wiring`. The
 * claude-code-channel routes inbound messages through
 * `MoltZapChannelCore` (`entry.ts:166@6e7a4e7`) and exposes
 * `sendReply` to the MCP stdio surface (`server.ts:71@6e7a4e7`). The
 * MCP server side may have a long-running tool call in flight when a
 * conversation is archived; this wiring closes the in-flight
 * AbortController so the tool call returns a tagged cancellation
 * before the model writes more output.
 */

import type { ConversationId } from "@moltzap/protocol";
import type { ChannelCancelRegistry } from "@moltzap/client";

/**
 * Register an MCP tool-call AbortController against the registry.
 * Mirrors `beginOpenclawTurnCancellation` from the openclaw plugin —
 * the shape is per-plugin (each owns its own dispatcher) but the
 * registry is one and shared.
 */
export interface ClaudeCodeToolCancellation {
  readonly signal: AbortSignal;
  release(): void;
}

export function beginClaudeCodeToolCancellation(_params: {
  readonly registry: ChannelCancelRegistry;
  readonly conversationId: ConversationId;
}): ClaudeCodeToolCancellation {
  throw new Error("not implemented");
}
