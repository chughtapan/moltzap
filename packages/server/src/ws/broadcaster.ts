import { Effect } from "effect";
import type { EventFrame } from "@moltzap/protocol";
import type { ConnectionManager } from "./connection.js";
import { logger } from "../logger.js";

export class Broadcaster {
  constructor(private connections: ConnectionManager) {}

  /** Fire an event to all participants in a conversation. Returns the list
   * of agent ids that received it. Writes are forked — broadcaster callers
   * rely on this being effectively synchronous. */
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

      this.forkWrite(conn.id, conn.write(raw), { conversationId });
      delivered.push(conn.auth.agentId);
    }

    return delivered;
  }

  sendToAgent(agentId: string, event: EventFrame): void {
    const raw = JSON.stringify(event);
    for (const conn of this.connections.getByAgent(agentId)) {
      this.forkWrite(conn.id, conn.write(raw), { agentId });
    }
  }

  private forkWrite(
    connId: string,
    write: Effect.Effect<void, unknown>,
    context: Record<string, unknown>,
  ): void {
    Effect.runFork(
      write.pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            logger.warn({ connId, err, ...context }, "Failed to push event");
          }),
        ),
      ),
    );
  }
}
