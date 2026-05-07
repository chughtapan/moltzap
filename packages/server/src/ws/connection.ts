import { Effect, type Scope } from "effect";
import * as Socket from "@effect/platform/Socket";
import {
  makeJsonRpcClient,
  type AnyTaskCallbackRpcDefinition,
  type JsonRpcClient,
  type ParamsOf,
  type ResultOf,
  type RpcCallError,
} from "@moltzap/protocol";
import type { AuthenticatedContext } from "../rpc/context.js";

export interface MoltZapConnection {
  id: string;
  /** Write a raw frame to this connection. Fails with SocketError on send
   * failure or if the socket is already closed. */
  write: (raw: string) => Effect.Effect<void, Socket.SocketError>;
  /** Close this connection's scope, tearing down the underlying socket. */
  shutdown: Effect.Effect<void>;
  auth: AuthenticatedContext | null;
  lastPong: number;
  conversationIds: Set<string>;
  mutedConversations: Set<string>;
  /**
   * Originator side of this connection's server→client appCallback channel.
   * Mints `srv-${connId}-N` request ids, tracks pending Deferreds, and
   * fails every still-pending call with `NotConnectedError` when the
   * surrounding scope closes (Scope finalizer registered by
   * `makeJsonRpcClient`).
   */
  readonly jsonRpcClient: JsonRpcClient;
}

/**
 * Allocate a per-connection `JsonRpcClient` whose request ids are prefixed
 * `srv-${connectionId}` (keeps server-originated ids disjoint from client
 * ids in logs and captures). The Scope finalizer registered by
 * `makeJsonRpcClient` drains pending Deferreds with `NotConnectedError`
 * when the connection scope closes.
 */
export function acquireConnectionRpcClient(
  connectionId: string,
  write: (raw: string) => Effect.Effect<void, Socket.SocketError>,
): Effect.Effect<JsonRpcClient, never, Scope.Scope> {
  return makeJsonRpcClient({
    write,
    idPrefix: `srv-${connectionId}`,
  });
}

/**
 * Send an awaitable RPC from server → client over `connection`'s WebSocket.
 *
 * Generic-narrowing wrapper around `connection.jsonRpcClient.call` that
 * constrains `D` to the task-callback RPC union — prevents accidental
 * dispatch of a client→server method on the appCallback channel.
 *
 * Caller controls timeout via `Effect.timeout` at the call site.
 */
export function sendRpcToClient<D extends AnyTaskCallbackRpcDefinition>(
  connection: MoltZapConnection,
  definition: D,
  params: ParamsOf<D>,
): Effect.Effect<ResultOf<D>, RpcCallError, never> {
  return connection.jsonRpcClient.call(definition, params);
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

  getByAgent(agentId: string): MoltZapConnection[] {
    return Array.from(this.connections.values()).filter(
      (conn) => conn.auth && conn.auth.agentId === agentId,
    );
  }

  /**
   * Subscribe all currently-connected sockets of the given agents to a
   * conversation. Adds `conversationId` to each matching connection's
   * `conversationIds` set. Idempotent: a connection already subscribed is
   * a no-op (Set semantics). Returns the list of connection ids that were
   * subscribed (for observability + tests).
   *
   * Exposed for downstream apps that create conversations via
   * `ConversationService.create` directly (rather than the `conversations/
   * create` RPC handler, which already does this work internally). Without
   * this helper, every consumer re-implements the same loop and drifts when
   * the subscription shape changes.
   */
  subscribeAgentsToConversation(
    agentIds: readonly string[],
    conversationId: string,
  ): string[] {
    const subscribed: string[] = [];
    const agentSet = new Set(agentIds);
    for (const conn of this.connections.values()) {
      if (!conn.auth) continue;
      if (!agentSet.has(conn.auth.agentId)) continue;
      conn.conversationIds.add(conversationId);
      subscribed.push(conn.id);
    }
    return subscribed;
  }

  entries(): IterableIterator<[string, MoltZapConnection]> {
    return this.connections.entries();
  }

  get size(): number {
    return this.connections.size;
  }
}
