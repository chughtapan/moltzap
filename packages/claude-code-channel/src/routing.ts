/**
 * routing — internal tracker for the `reply` tool's routing decision.
 *
 * OQ5 resolution (spec OQ5 default A): the contract's `reply` tool takes
 * `{text, reply_to?, files?}` with no `chat_id`. MoltZap sessions can span
 * multiple conversations, so the package must resolve which (task, conv)
 * pair a `reply` call targets.
 */

import { Data } from "effect";
import type { ConversationId, MessageId, TaskId } from "./types.js";

class RoutingCapacityInvalid extends Data.TaggedError(
  "RoutingCapacityInvalid",
)<{
  readonly capacity: number;
  readonly message: string;
}> {}

export interface RoutingTarget {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

export interface RoutingState {
  readonly recordInbound: (messageId: MessageId, target: RoutingTarget) => void;
  readonly resolveTarget: (replyTo: MessageId | undefined) => RoutingResolution;
}

type RoutingResolution =
  | { readonly _tag: "Resolved"; readonly target: RoutingTarget }
  | { readonly _tag: "NoActiveConversation" }
  | { readonly _tag: "ReplyToUnknown"; readonly replyTo: MessageId };

const DEFAULT_CAPACITY = 256;

/**
 * Construct a fresh routing state. One instance per boot.
 *
 * Tracks message-id → `RoutingTarget` (task + conversation pair) for
 * `reply_to` resolution. Does NOT track dispatch lease tokens — the
 * lease FSM lives on the MoltZap server (see `messages/send`
 * rejection projection via `catchLeaseInvalid` in the channel-base
 * library).
 *
 * ```text
 * Map&lt;MessageId, RoutingTarget>  bounded LRU, cap=256
 * lastActive: RoutingTarget | undefined
 *
 * recordInbound(messageId, target):
 *   - insert (or refresh) entry in LRU order
 *   - update lastActive
 *   - evict oldest if size > cap
 *
 * resolveTarget(replyTo: MessageId | undefined):
 *   - undefined → lastActive ?? NoActiveConversation
 *   - present  → map.get(replyTo) ?? ReplyToUnknown
 * ```
 *
 * Bounded LRU prevents unbounded memory growth in long-running
 * processes; eviction order is FIFO via JavaScript `Map` insertion
 * preservation.
 *
 * Server-side lease rejection (`RpcServerError { data.reason:
 * "LeaseInvalid" }`) projects into a `LeaseAlreadyConsumed` typed
 * error via `channel-base.catchLeaseInvalid`, which the reply tool
 * surfaces to Claude as `toolErrorResult`.
 * @param capacity bounded LRU size (default 256). Exceeding the cap
 * evicts the oldest. Must be a positive finite number.
 */
export function createRoutingState(
  capacity: number = DEFAULT_CAPACITY,
): RoutingState {
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new RoutingCapacityInvalid({
      capacity,
      message: `createRoutingState: capacity must be a positive finite number, got ${capacity}`,
    });
  }
  const cap = Math.floor(capacity);
  const map = new Map<MessageId, RoutingTarget>();
  let lastActive: RoutingTarget | undefined;

  function recordInbound(messageId: MessageId, target: RoutingTarget): void {
    if (map.has(messageId)) {
      map.delete(messageId);
    }
    map.set(messageId, target);
    while (map.size > cap) {
      const oldest = map.keys().next();
      if (oldest.done === true) {
        break;
      }
      map.delete(oldest.value);
    }
    lastActive = target;
  }

  function resolveTarget(replyTo: MessageId | undefined): RoutingResolution {
    if (replyTo !== undefined) {
      const hit = map.get(replyTo);
      if (hit !== undefined) {
        return { _tag: "Resolved", target: hit };
      }
      return { _tag: "ReplyToUnknown", replyTo };
    }
    if (lastActive !== undefined) {
      return { _tag: "Resolved", target: lastActive };
    }
    return { _tag: "NoActiveConversation" };
  }

  return { recordInbound, resolveTarget };
}
