import { Effect } from "effect";
import type { EventFrame } from "@moltzap/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ConnectionManager } from "./connection.js";
import { logger } from "../logger.js";

function appendBroadcastTrace(record: Record<string, unknown>): void {
  const dir = process.env["MOLTZAP_SERVER_BROADCAST_LOG_DIR"];
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "server-broadcasts.jsonl"),
      JSON.stringify(record) + "\n",
    );
  } catch (err) {
    logger.debug(
      { err },
      "server broadcast trace write failed; continuing without diagnostics",
    );
  }
}

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

    appendBroadcastTrace({
      ts: new Date().toISOString(),
      kind: "conversation",
      conversationId,
      event: event.event,
      deliveredAgentIds: delivered,
      deliveredCount: delivered.length,
      excludedConnectionId: excludeConnectionId,
    });

    return delivered;
  }

  sendToAgent(agentId: string, event: EventFrame): void {
    const raw = JSON.stringify(event);
    let deliveredCount = 0;
    for (const conn of this.connections.getByAgent(agentId)) {
      this.forkWrite(conn.id, conn.write(raw), { agentId });
      deliveredCount += 1;
    }
    appendBroadcastTrace({
      ts: new Date().toISOString(),
      kind: "agent",
      agentId,
      event: event.event,
      deliveredCount,
    });
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
