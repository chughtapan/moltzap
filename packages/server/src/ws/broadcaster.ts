import type { EventFrame } from "@moltzap/protocol";
import type { ConnectionManager } from "./connection.js";
import { logger } from "../logger.js";

export class Broadcaster {
  constructor(private connections: ConnectionManager) {}

  /**
   * Send an event to all participants in a conversation.
   * Returns the list of agent IDs that received the event.
   */
  broadcastToConversation(
    conversationId: string,
    event: EventFrame,
    excludeConnectionId?: string,
  ): string[] {
    const delivered: string[] = [];
    const raw = JSON.stringify(event);

    for (const [connId, conn] of this.connections.entries()) {
      if (connId === excludeConnectionId) continue;
      if (!conn.conversationIds.has(conversationId)) continue;
      if (!conn.auth) continue;
      if (conn.mutedConversations.has(conversationId)) continue;

      try {
        conn.ws.send(raw);
        delivered.push(conn.auth.agentId);
      } catch (err) {
        logger.warn(
          { connId, conversationId, err },
          "Failed to push event to connection",
        );
      }
    }

    return delivered;
  }

  /**
   * Send an event to a specific agent (all their connections).
   */
  sendToAgent(agentId: string, event: EventFrame): void {
    const raw = JSON.stringify(event);
    for (const conn of this.connections.getByAgent(agentId)) {
      try {
        conn.ws.send(raw);
      } catch (err) {
        logger.warn({ agentId, err }, "Failed to send to agent");
      }
    }
  }
}
