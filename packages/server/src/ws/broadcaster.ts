import { Config, ConfigProvider, Effect, Option } from "effect";
import type { NotificationFrame } from "@moltzap/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ConnectionManager } from "./connection.js";
import { logger } from "../logger.js";

const ServerBroadcastLogDir = Config.option(
  Config.string("MOLTZAP_SERVER_BROADCAST_LOG_DIR"),
);

const getServerBroadcastLogDir = (): string | undefined =>
  Option.getOrUndefined(
    Effect.runSync(
      ServerBroadcastLogDir.pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    ),
  );

function appendBroadcastTrace(record: Record<string, unknown>): void {
  const dir = getServerBroadcastLogDir();
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

  /** Fire a notification to all participants in a conversation. Returns the list
   * of agent ids that received it. Writes are forked — broadcaster callers
   * rely on this being effectively synchronous. */
  broadcastToConversation(
    conversationId: string,
    notification: NotificationFrame,
    excludeConnectionId?: string,
  ): string[] {
    const delivered: string[] = [];
    const raw = JSON.stringify(notification);

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
      notification: notification.method,
      deliveredAgentIds: delivered,
      deliveredCount: delivered.length,
      excludedConnectionId: excludeConnectionId,
    });

    return delivered;
  }

  sendToAgent(agentId: string, notification: NotificationFrame): void {
    const raw = JSON.stringify(notification);
    let deliveredCount = 0;
    for (const conn of this.connections.getByAgent(agentId)) {
      this.forkWrite(conn.id, conn.write(raw), { agentId });
      deliveredCount += 1;
    }
    appendBroadcastTrace({
      ts: new Date().toISOString(),
      kind: "agent",
      agentId,
      notification: notification.method,
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
            logger.warn(
              { connId, err, ...context },
              "Failed to push notification",
            );
          }),
        ),
      ),
    );
  }
}
