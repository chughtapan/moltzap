import { HashMap } from "effect";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";

/**
 * Helpers extracted from `service.ts → markConversationArchived` to keep
 * the function under the 50-line ESLint cap and the file under the
 * 1050-line cap.
 */

export function purgeAgentCacheEntries(
  m: HashMap.HashMap<
    string,
    { readonly taskId: TaskId; readonly conversationId: ConversationId }
  >,
  conversationId: ConversationId,
): HashMap.HashMap<
  string,
  { readonly taskId: TaskId; readonly conversationId: ConversationId }
> {
  let next = HashMap.empty<
    string,
    { readonly taskId: TaskId; readonly conversationId: ConversationId }
  >();
  for (const [agentName, entry] of HashMap.entries(m)) {
    if (entry.conversationId !== conversationId) {
      next = HashMap.set(next, agentName, entry);
    }
  }
  return next;
}

export function purgeLastNotified(
  outer: HashMap.HashMap<string, HashMap.HashMap<string, string>>,
  conversationId: ConversationId,
): HashMap.HashMap<string, HashMap.HashMap<string, string>> {
  let next = HashMap.empty<string, HashMap.HashMap<string, string>>();
  for (const [viewConvId, markers] of HashMap.entries(outer)) {
    if (viewConvId !== conversationId) {
      next = HashMap.set(
        next,
        viewConvId,
        HashMap.remove(markers, conversationId),
      );
    }
  }
  return next;
}

export function purgeLastRead(
  outer: HashMap.HashMap<string, HashMap.HashMap<string, ReadonlySet<string>>>,
  conversationId: ConversationId,
): HashMap.HashMap<string, HashMap.HashMap<string, ReadonlySet<string>>> {
  let next = HashMap.empty<
    string,
    HashMap.HashMap<string, ReadonlySet<string>>
  >();
  for (const [sessionKey, perConv] of HashMap.entries(outer)) {
    next = HashMap.set(
      next,
      sessionKey,
      HashMap.remove(perConv, conversationId),
    );
  }
  return next;
}
