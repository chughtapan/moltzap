import { ConversationKeyError } from "./errors.js";

/**
 * Thin wrapper around a raw AppSession with conversation-key helpers.
 */
export class AppSessionHandle {
  readonly id: string;
  readonly appId: string;
  readonly status: string;
  /** Map of conversation key -> conversation ID */
  readonly conversations: Record<string, string>;

  constructor(raw: {
    id: string;
    appId: string;
    status: string;
    conversations: Record<string, string>;
  }) {
    this.id = raw.id;
    this.appId = raw.appId;
    this.status = raw.status;
    this.conversations = raw.conversations;
  }

  /** Resolve a conversation key to its ID. Throws ConversationKeyError if unknown. */
  conversationId(key: string): string {
    const id = this.conversations[key];
    if (!id) {
      throw new ConversationKeyError(key);
    }
    return id;
  }

  get isActive(): boolean {
    return this.status === "active";
  }
}
