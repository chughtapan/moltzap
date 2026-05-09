/**
 * Per-conversation in-flight cancellation registry for channel plugins.
 *
 * Architect-281 §3 — module `channel-cancel`. This is the SHARED helper
 * that openclaw, nanoclaw, and claude-code-channel each consume to
 * cancel in-flight model turns / dispatcher work when a conversation is
 * archived or closed.
 *
 * Boundary: this module owns the mapping `(conversationId →
 * AbortController[])`. Channel-core fires the lifecycle event; plugins
 * register their per-turn AbortController; the registry aborts each
 * controller when a close arrives.
 *
 * Channel-core already drops queued inbound work and drops outbound
 * `sendReply` calls for closed conversations (`channel-core.ts`
 * `closeConversation` and `sendReply` guard, both at SHA 6e7a4e7). The
 * gap this module closes is in-flight LLM turns whose AbortSignal was
 * minted before the close arrived; without the registry their tokens
 * burn to completion and their final reply is dropped only at the
 * already-too-late `sendReply` guard.
 *
 * Failure mode: silent. A registered controller that has already
 * fired `abort()` is a no-op on cancel; an unknown conversationId is a
 * no-op. The registry never throws into caller code.
 */

import type { ConversationId } from "@moltzap/protocol";

/**
 * Reason an in-flight handle was canceled. Discriminated union so each
 * downstream plugin can attach a tagged cause to its own
 * cancellation-aware code path (e.g. OpenClaw's per-turn telemetry).
 *
 * Architect §5 names the closed set:
 *   - `archived`         → `conversations/archived` notification arrived.
 *   - `task-closed`      → `tasks/close` produced `TaskClosedError`
 *                          on a subsequent `messages/send` (post-#576).
 *   - `service-shutdown` → channel-core `disconnect()` is tearing down.
 */
export type ChannelCancelReason =
  | { readonly _tag: "archived"; readonly conversationId: ConversationId }
  | { readonly _tag: "task-closed"; readonly conversationId: ConversationId }
  | { readonly _tag: "service-shutdown" };

/**
 * Handle returned to the plugin when it registers an in-flight
 * AbortController for a conversation. The plugin calls `release()`
 * when its turn finishes normally so the registry does not retain a
 * dead controller.
 *
 * Bodies belong to `implement-*`. Architect ships only the shape.
 */
export interface ChannelCancelHandle {
  readonly conversationId: ConversationId;
  release(): void;
}

/**
 * Public surface of the cancel registry. Plugins consume this through
 * `MoltZapChannelCore.cancelRegistry()`; the registry is owned by the
 * core so every plugin sharing one core also shares one registry.
 *
 * Errors: none. The registry's contract is total — registration of an
 * already-aborted controller is allowed (a redundant abort is a no-op);
 * cancellation of an unknown conversation is a no-op.
 */
export interface ChannelCancelRegistry {
  /**
   * Register an AbortController for an in-flight unit of work scoped to
   * `conversationId`. The registry calls `controller.abort(reason)` on
   * every registered controller for that conversation when
   * `cancelConversation` fires; the controller's `abort` is the only
   * side-effect the registry produces.
   *
   * Returns a release handle so the plugin can deregister the
   * controller after a normal completion. Failing to release is not a
   * memory leak — a closed conversation drops every controller — but it
   * does keep the controller eligible for redundant abort on close.
   */
  register(
    conversationId: ConversationId,
    controller: AbortController,
  ): ChannelCancelHandle;

  /**
   * Abort every registered controller for `conversationId` with the
   * given reason. Idempotent — the second call for the same id is a
   * no-op because the registry deletes the bucket on the first call.
   */
  cancelConversation(
    conversationId: ConversationId,
    reason: ChannelCancelReason,
  ): void;

  /**
   * Abort every registered controller across every conversation with
   * `service-shutdown`. Used by `MoltZapChannelCore.disconnect()` to
   * drain in-flight work as the channel tears down. Idempotent.
   */
  cancelAll(): void;

  /**
   * Subscribe to cancel events. The handler runs once per
   * `cancelConversation` call (after the controllers abort). Plugins
   * use this to surface telemetry — the actual abort propagation is
   * via the AbortSignal the plugin already holds.
   */
  onCancel(handler: (reason: ChannelCancelReason) => void): void;
}

/**
 * Construct a fresh registry. One registry per `MoltZapChannelCore`
 * instance; the core wires its `conversationArchived` event to call
 * `cancelConversation` with `_tag: "archived"`.
 *
 * Implementer (junior) fills the body. Public surface is the registry
 * interface above; internal data structures are implementation choice
 * (a `Map<ConversationId, Set<AbortController>>` is the obvious one
 * but is not part of the contract).
 */
export function createChannelCancelRegistry(): ChannelCancelRegistry {
  throw new Error("not implemented");
}
