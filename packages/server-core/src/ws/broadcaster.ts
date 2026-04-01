import type { EventFrame, ParticipantRef } from "@moltzap/protocol";
import type { ConnectionManager } from "./connection.js";
import { logger } from "../logger.js";

export class Broadcaster {
  constructor(private connections: ConnectionManager) {}

  /**
   * Send an event to all participants in a conversation.
   * Returns the list of participant refs that received the event.
   */
  broadcastToConversation(
    conversationId: string,
    event: EventFrame,
    excludeConnectionId?: string,
  ): ParticipantRef[] {
    const delivered: ParticipantRef[] = [];
    const raw = JSON.stringify(event);

    for (const [connId, conn] of this.connections.entries()) {
      if (connId === excludeConnectionId) continue;
      if (!conn.conversationIds.has(conversationId)) continue;
      if (!conn.auth) continue;
      if (conn.mutedConversations.has(conversationId)) continue;

      try {
        conn.ws.send(raw);
        const participantId =
          conn.auth.kind === "user" ? conn.auth.userId : conn.auth.agentId;
        delivered.push({ type: conn.auth.kind, id: participantId });
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
   * Send an event to a specific participant (all their connections).
   */
  sendToParticipant(type: string, id: string, event: EventFrame): void {
    const raw = JSON.stringify(event);
    for (const conn of this.connections.getByParticipant(type, id)) {
      try {
        conn.ws.send(raw);
      } catch (err) {
        logger.warn(
          { participantType: type, participantId: id, err },
          "Failed to send to participant",
        );
      }
    }
  }

  /**
   * Send an event to a user AND all their agent connections.
   * Contact events need this because agents connect with agentKey (kind="agent"),
   * not as users. Without this, agents never receive contact events.
   */
  sendToUserAndAgents(userId: string, event: EventFrame): void {
    const raw = JSON.stringify(event);
    for (const [, conn] of this.connections.entries()) {
      if (!conn.auth) continue;
      const isUserConn =
        conn.auth.kind === "user" && conn.auth.userId === userId;
      const isOwnedAgentConn =
        conn.auth.kind === "agent" && conn.auth.ownerUserId === userId;
      if (isUserConn || isOwnedAgentConn) {
        try {
          conn.ws.send(raw);
        } catch (err) {
          logger.warn(
            { userId, err },
            "Failed to send to user/agent connection",
          );
        }
      }
    }
  }
}
