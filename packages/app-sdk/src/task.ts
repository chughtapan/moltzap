import { ConversationKeyError } from "./errors.js";

/**
 * Thin wrapper around a raw `Task` with conversation-key helpers.
 * Replaces `AppSessionHandle`. Public shape mirrors the previous handle
 * one-for-one with `id`/`appId`/`status`/`conversations`; the rename is
 * purely the class + field name (`session*` → `task*`).
 */
export class TaskHandle {
  readonly id: string;
  readonly appId: string;
  readonly status: string;
  /** Map of conversation key -> conversation ID. */
  readonly conversations: Record<string, string>;

  constructor(raw: {
    id: string;
    appId: string;
    status: string;
    conversations: Record<string, string>;
  }) {
    throw new Error("not implemented");
  }

  /**
   * Resolve a conversation key to its ID. Fails with `ConversationKeyError`
   * when the key is not registered on this task. (Kept throw semantics for
   * API parity with `AppSessionHandle.conversationId`.)
   */
  conversationId(key: string): string {
    throw new Error("not implemented");
  }

  get isActive(): boolean {
    throw new Error("not implemented");
  }
}
