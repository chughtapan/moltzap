import { Effect, type Scope } from "effect";
import * as Socket from "@effect/platform/Socket";
import {
  makeAgentClientConnection,
  type AgentClientConnection,
  type AnyTaskCallbackRpcDefinition,
  type ParamsOf,
  type ResultOf,
  type RpcCallError,
  type RpcDefinition,
} from "@moltzap/protocol";
import type { AuthenticatedContext } from "../transport/context.js";

export interface MoltZapConnection {
  id: string;

  /**
   * Write a raw frame to this connection. Fails with SocketError on send
   * failure or if the socket is already closed.
   */
  write: (raw: string) => Effect.Effect<void, Socket.SocketError>;

  /** Close this connection's scope, tearing down the underlying socket. */
  shutdown: Effect.Effect<void>;
  auth: AuthenticatedContext | null;
  lastPong: number;
  conversationIds: Set<string>;
  mutedConversations: Set<string>;

  /**
   * Originator side of this connection's server→client appCallback channel
   * (Spec F #617 typed-dispatcher `AgentClientConnection`). Mints
   * `srv-${connId}-N` request ids, tracks pending Deferreds, and fails
   * every still-pending call with `NotConnectedError` when the
   * surrounding scope closes (Scope finalizer from the internalized
   * originator helper). The per-conversation `sendRpcToClient` wrapper
   * narrows the outbound call to `AnyTaskCallbackRpcDefinition`.
   */
  readonly originator: AgentClientConnection;
}

/**
 * Allocate a per-connection originator whose request ids are prefixed
 * `srv-${connectionId}` (keeps server-originated ids disjoint from client
 * ids in logs and captures). The Scope finalizer registered by the
 * internalized originator helper drains pending Deferreds with
 * `NotConnectedError` when the connection scope closes.
 *
 * The empty `handlers: {}` literal is well-typed against
 * `AgentClientHandlers&lt;...&gt;` — Spec F's AgentClient catalog is empty,
 * so the dispatcher never invokes the inbound surface.
 */
export function acquireConnectionRpcClient(
  connectionId: string,
  write: (raw: string) => Effect.Effect<void, Socket.SocketError>,
): Effect.Effect<AgentClientConnection, never, Scope.Scope> {
  return makeAgentClientConnection<never, never>({
    id: connectionId,
    handlers: {},
    write,
    idPrefix: `srv-${connectionId}`,
  });
}

/**
 * Send an awaitable RPC from server → client over `connection`'s WebSocket.
 *
 * Generic-narrowing wrapper around `connection.originator.call` that
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
  // `AnyTaskCallbackRpcDefinition` is a strict subset of the originator's
  // `AnyRpcDefinition` bound; the cast widens to the originator's
  // generic constraint shape without losing the per-definition
  // narrowing the caller provides.
  const call = connection.originator.call as <
    D2 extends RpcDefinition<string, any, any>,
  >(
    definition: D2,
    params: ParamsOf<D2>,
  ) => Effect.Effect<ResultOf<D2>, RpcCallError>;
  return call(definition, params);
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
      if (conn.auth && agentSet.has(conn.auth.agentId)) {
        conn.conversationIds.add(conversationId);
        subscribed.push(conn.id);
      }
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
