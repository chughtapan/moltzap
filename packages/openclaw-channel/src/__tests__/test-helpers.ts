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
import { registerAgent } from "@moltzap/client/auth";
import { Effect } from "effect";

const WAIT_FOR_POLL_INTERVAL_MS = 50;

class WaitForTimeoutError extends Error {
  override readonly name = "WaitForTimeoutError";
}

/**
 * Registers test agent.
 * @param name Name of the operation.
 * @returns The register test agent result.
 */
export function registerTestAgent(name: string) {
  const baseUrl = inject("baseUrl");

  return Effect.runPromise(
    registerAgent(baseUrl, name).pipe(Effect.withSpan("registerTestAgent")),
  );
}

import type { ConversationId } from "@moltzap/protocol/conversation";

/**
 * Executes the extract message operation.
 * @param event Value supplied to the operation.
 * @returns The extract message result.
 */
export function extractMessage(event: MessageReceivedNotification): Message {
  return event.message;
}

/**
 * Executes the extract conv id operation.
 * @param result Value supplied to the operation.
 * @returns The extract conv id result.
 */
export function extractConvId(result: unknown): string {
  return (
    /* Safe because the test fixture establishes this asserted shape. */
    (result as { conversation: { id: string } }).conversation.id
  );
}

/** Describes a conversation binding. */
export interface ConversationBinding {
  readonly conversationId: ConversationId;
}

/**
 * Executes the extract conversation binding operation.
 * @param result Value supplied to the operation.
 * @returns The extract conversation binding result.
 */
export function extractConversationBinding(
  result: unknown,
): ConversationBinding {
  const typed =
    /* Safe because the test fixture establishes this asserted shape. */ result as {
      conversation: { id: ConversationId };
    };
  return { conversationId: typed.conversation.id };
}

/**
 * Executes the extract text operation.
 * @param message Value supplied to the operation.
 * @returns The extract text result.
 */
export function extractText(message: Message): string {
  const part = message.parts[0];
  return part && "text" in part ? part.text : "";
}

/**
 * Waits for for.
 * @param predicate Predicate used to select matching values.
 * @param timeoutMs Maximum time to wait in milliseconds.
 * @returns A promise that completes when the predicate succeeds.
 */
export function waitFor(predicate: () => boolean, timeoutMs: number) {
  return new Promise<undefined>((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve(undefined);
      } else if (Date.now() - start > timeoutMs) {
        reject(new WaitForTimeoutError("waitFor timeout"));
      } else {
        setTimeout(check, WAIT_FOR_POLL_INTERVAL_MS);
      }
    };
    check();
  });
}
