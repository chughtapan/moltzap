/**
 * Per-turn AbortController registration for the OpenClaw channel plugin.
 *
 * Architect-281 §3 — module `openclaw-cancel`. Wires
 * `MoltZapChannelCore.cancelRegistry()` into the per-turn AbortController
 * that OpenClaw's `dispatchReplyWithBufferedBlockDispatcher` already
 * consumes (the existing `abortSignal` plumbed through
 * `OpenClawStartAccountContext`, `openclaw-entry.ts:132@6e7a4e7`).
 *
 * Today the per-turn AbortController is forked off the account-level
 * `abortSignal` and only fires when the whole account stops. This
 * module forks a per-conversation child controller so an archive
 * targeting one conversation aborts only that conversation's in-flight
 * model run while leaving other conversations untouched.
 */

import type { ConversationId } from "@moltzap/protocol";
import type {
  ChannelCancelHandle,
  ChannelCancelRegistry,
} from "@moltzap/client";

/**
 * Begin tracking a per-turn AbortController for `conversationId` and
 * return both the child signal (to pass to OpenClaw's reply
 * dispatcher) and the release handle (call after the turn finishes).
 *
 * The child controller is wired so:
 *   - parent `abortSignal` aborting (account stop) aborts the child;
 *   - registry-driven cancel for `conversationId` aborts the child;
 *   - the child's own `abort()` does NOT abort the parent.
 *
 * Errors: none. If the parent is already aborted at registration
 * time, the returned signal is already aborted; the dispatcher
 * short-circuits at its own `abortSignal.aborted` guard.
 */
export interface OpenclawTurnCancellation {
  readonly signal: AbortSignal;
  readonly handle: ChannelCancelHandle;
}

export function beginOpenclawTurnCancellation(_params: {
  readonly registry: ChannelCancelRegistry;
  readonly conversationId: ConversationId;
  readonly parentSignal: AbortSignal;
}): OpenclawTurnCancellation {
  throw new Error("not implemented");
}
