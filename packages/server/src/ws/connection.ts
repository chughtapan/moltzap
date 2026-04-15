import type { WSContext } from "hono/ws";
import type { AuthenticatedContext } from "../rpc/context.js";

export interface MoltZapConnection {
  id: string;
  ws: WSContext;
  auth: AuthenticatedContext | null;
  activeAgentId: string | null;
  lastPong: number;
  conversationIds: Set<string>;
  mutedConversations: Set<string>;
  /** Cached control-channel conversation ID for human→agent DMs. Cleared on agent switch. */
  controlChannelId: string | null;
}

export class ConnectionManager {
  private connections = new Map<string, MoltZapConnection>();

  add(conn: MoltZapConnection): void {
    this.connections.set(conn.id, conn);
  }

  remove(id: string): void {
    this.connections.delete(id);
  }

  get(id: string): MoltZapConnection | undefined {
    return this.connections.get(id);
  }

  all(): MoltZapConnection[] {
    return [...this.connections.values()];
  }

  getByParticipant(type: string, id: string): MoltZapConnection[] {
    return Array.from(this.connections.values()).filter(
      (conn) =>
        conn.auth &&
        ((conn.auth.kind === "user" &&
          type === "user" &&
          conn.auth.userId === id) ||
          (conn.auth.kind === "agent" &&
            type === "agent" &&
            conn.auth.agentId === id) ||
          (conn.auth.kind === "user" &&
            type === "agent" &&
            conn.activeAgentId === id)),
    );
  }

  /** Iterate all connections. */
  entries(): IterableIterator<[string, MoltZapConnection]> {
    return this.connections.entries();
  }

  get size(): number {
    return this.connections.size;
  }
}
