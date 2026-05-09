/**
 * Per-turn cancellation wiring for the nanoclaw MoltZap channel.
 *
 * Architect-281 §3 — module `nanoclaw-channel-cancel-wiring`. Nanoclaw's
 * inbound handler (`channels/moltzap.ts:110@6e7a4e7`) currently treats
 * each inbound message as a synchronous-ish handler call. The channel
 * has no per-turn AbortController to feed; the cancel surface for
 * nanoclaw is therefore narrower than OpenClaw's.
 *
 * This module exposes the registry to the nanoclaw channel for the
 * one case nanoclaw cares about: a long-running block-dispatcher reply
 * fired through `core.sendReply`. Nanoclaw owns the buffered block
 * machinery directly; the wiring here drops queued blocks for a
 * canceled conversation before they reach `core.sendReply`.
 *
 * Symmetry rationale: openclaw, nanoclaw, and claude-code-channel each
 * own their own dispatcher; the cancel hook is per-plugin even though
 * the registry is shared. Sharing the wire (one registry on the core)
 * with per-plugin wiring is the §3 design call.
 */

import type { ConversationId } from "@moltzap/protocol";
import type { ChannelCancelRegistry } from "@moltzap/client";

/**
 * Subscribe nanoclaw's per-conversation block buffer to the registry.
 * On cancel, the buffer for `conversationId` is purged before the
 * next `core.sendReply` would have fired.
 *
 * The handle returned has `unsubscribe()` for test teardown; the
 * plugin's `stopAccount` calls it to avoid retaining handlers across
 * reconnects.
 */
export interface NanoclawCancelSubscription {
  unsubscribe(): void;
}

export function subscribeNanoclawCancel(_params: {
  readonly registry: ChannelCancelRegistry;
  readonly purge: (conversationId: ConversationId) => void;
}): NanoclawCancelSubscription {
  throw new Error("not implemented");
}
