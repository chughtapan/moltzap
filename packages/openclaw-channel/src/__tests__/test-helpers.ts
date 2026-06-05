/**
 * Shared test helpers for openclaw-channel integration tests.
 *
 * Agent-only: helpers operate exclusively on agent identifiers exposed by
 * the shared client registration helper.
 */

import { inject } from "vitest";
import type {
  Message,
  MessageReceivedNotification,
} from "@moltzap/protocol/message";
import { registerAgent } from "@moltzap/client";
import { Effect } from "effect";

const WAIT_FOR_POLL_INTERVAL_MS = 50;

class WaitForTimeoutError extends Error {
  override readonly name = "WaitForTimeoutError";
}

export function registerTestAgent(name: string) {
  const baseUrl = inject("baseUrl");

  return Effect.runPromise(
    registerAgent(baseUrl, name).pipe(Effect.withSpan("registerTestAgent")),
  );
}

import type { ConversationId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";

export function extractMessage(event: MessageReceivedNotification): Message {
  return event.message;
}

export function extractConvId(result: unknown): string {
  return (result as { conversation: { id: string } }).conversation.id;
}

export interface TaskBinding {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

export function extractTaskBinding(result: unknown): TaskBinding {
  const typed = result as {
    task: { id: TaskId };
    conversation: { id: ConversationId } | null;
  };
  if (typed.conversation === null) {
    throw new Error("TaskRequest result missing initial conversation");
  }
  return { taskId: typed.task.id, conversationId: typed.conversation.id };
}

export function extractText(message: Message): string {
  const part = message.parts[0];
  return part && "text" in part ? part.text : "";
}

export function waitFor(predicate: () => boolean, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new WaitForTimeoutError("waitFor timeout"));
      } else {
        setTimeout(check, WAIT_FOR_POLL_INTERVAL_MS);
      }
    };
    check();
  });
}
