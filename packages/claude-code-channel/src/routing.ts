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
